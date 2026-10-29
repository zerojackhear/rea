package io.rea.mobile;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
  static final int FILE_PICK=10, CONFIG_PICK=11, EXPORT=12;
  static final int BG=0xff101819, CARD=0xff1c292b, GREEN=0xff69e2b4, TEXT=0xffeef5f2, MUTED=0xffa3b6b1;
  static final String[] ACTION_IDS={"javascript","android","flutter","dart","go","rust","sqlite","wasm"};
  static final String[] ACTION_LABELS={"JavaScript 静态分析","APK 深度分析 · 电脑需 JADX","Flutter 构建识别","Dart AOT 快照分析","Go 编译信息","Rust 编译信息","SQLite 结构检查","WASM 静态分析 · 电脑需 WABT"};
  final ExecutorService workers=Executors.newSingleThreadExecutor(),syncWorker=Executors.newSingleThreadExecutor(); final Handler ui=new Handler(Looper.getMainLooper());
  LinearLayout page; TextView status; String tab="local", message="离线可用 · 文件保留在手机，点击远程提交后才上传";
  volatile boolean busy=false; boolean visible=false,destroyed=false,syncing=false; long nextPollAt=0; int actionIndex=0;
  JSONObject selected,connection; JSONArray jobs=new JSONArray(); Object result; String exportText;
  interface Work { void run() throws Exception; }
  final Runnable poll=new Runnable(){public void run(){if(!visible||destroyed)return;if(tab.equals("remote")&&connection!=null&&!busy&&System.currentTimeMillis()>=nextPollAt)refresh(false);ui.postDelayed(this,4000);}};

  @Override public void onCreate(Bundle state) {
    super.onCreate(state); getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(BG);
    try {String saved=getPreferences(0).getString("selected",null); if(saved!=null){selected=new JSONObject(saved);if(!selectedFile().isFile())selected=null;} connection=ConnectionStore.load(this);}
    catch(Exception e){message="本地配置读取失败，请重新选择文件或导入连接。";}
    render();
  }
  @Override public void onResume(){super.onResume();visible=true;ui.removeCallbacks(poll);ui.postDelayed(poll,1000);}
  @Override public void onPause(){visible=false;ui.removeCallbacks(poll);super.onPause();}
  @Override public void onDestroy(){destroyed=true;ui.removeCallbacksAndMessages(null);workers.shutdownNow();syncWorker.shutdownNow();super.onDestroy();}
  int dp(int x){return (int)(x*getResources().getDisplayMetrics().density+0.5f);}
  TextView text(String value,int size,int color){TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setPadding(0,dp(5),0,dp(5));return v;}
  GradientDrawable background(int color){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(18));return d;}
  LinearLayout card(String title){LinearLayout c=new LinearLayout(this);c.setOrientation(1);c.setPadding(dp(18),dp(14),dp(18),dp(16));c.setBackground(background(CARD));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(14);page.addView(c,p);if(title!=null){TextView t=text(title,18,TEXT);t.setTypeface(null,Typeface.BOLD);c.addView(t);}return c;}
  Button button(String label,LinearLayout parent,Runnable callback){Button b=new Button(this);b.setText(label);b.setTextSize(14);b.setAllCaps(false);b.setTextColor(GREEN);b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(0xff2b403c));b.setMinHeight(dp(48));b.setOnClickListener(v->{if(busy){toast("正在处理，请稍候");return;}callback.run();});parent.addView(b,new LinearLayout.LayoutParams(-1,-2));return b;}
  void toast(String s){Toast.makeText(this,s,Toast.LENGTH_LONG).show();}
  void note(String s){message=s;if(status!=null)status.setText(s);}
  void work(String label,Work action){if(busy)return;busy=true;note(label);workers.execute(()->{try{action.run();}catch(Exception e){post(()->{note("未完成："+(e.getMessage()==null?e.getClass().getSimpleName():e.getMessage()));toast(message);});}finally{post(()->busy=false);}});}
  void post(Runnable action){ui.post(()->{if(!destroyed)action.run();});}
  void render(){
    LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setBackgroundColor(BG);
    root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
    LinearLayout heading=new LinearLayout(this);heading.setOrientation(1);heading.setPadding(dp(22),dp(12),dp(22),dp(8));root.addView(heading);
    TextView brand=text("REA  /  MOBILE",24,GREEN);brand.setTypeface(null,Typeface.BOLD);heading.addView(brand);heading.addView(text("你的随身分析工作台",13,MUTED));
    LinearLayout navigation=new LinearLayout(this);heading.addView(navigation);
    String[] ids={"local","remote","history"}, labels={"本地","电脑分析","记录"};
    for(int i=0;i<ids.length;i++){final String id=ids[i];Button b=new Button(this);b.setText(labels[i]);b.setTextColor(tab.equals(id)?BG:MUTED);b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(tab.equals(id)?GREEN:CARD));b.setAllCaps(false);navigation.addView(b,new LinearLayout.LayoutParams(0,dp(50),1));b.setOnClickListener(v->{tab=id;render();});}
    status=text(message,12,MUTED);heading.addView(status);
    ScrollView scroll=new ScrollView(this);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));page=new LinearLayout(this);page.setOrientation(1);page.setPadding(dp(20),dp(8),dp(20),dp(24));scroll.addView(page);
    if(tab.equals("local"))localPage();else if(tab.equals("remote"))remotePage();else historyPage();
    setContentView(root);root.requestApplyInsets();
  }
  void selectedCard(){
    LinearLayout c=card("当前文件");
    if(selected==null)c.addView(text("选择 APK、脚本、数据库或二进制文件。\n无需存储权限，不上传也能检查。",14,MUTED));
    else {c.addView(text(selected.optString("name"),16,TEXT));c.addView(text(String.format(Locale.ROOT,"%.2f MiB",selected.optLong("size")/1048576.0),13,MUTED));TextView sha=text("SHA-256\n"+selected.optString("sha256"),11,MUTED);sha.setTextIsSelectable(true);c.addView(sha);}
    button(selected==null?"＋ 选择文件":"更换文件",c,()->pick(FILE_PICK));
  }
  void localPage(){
    selectedCard();LinearLayout c=card("手机本地能力");c.addView(text("文件头与 SHA-256 · ZIP/APK 目录\n原生库 ABI · 有界字符串观察 · JSON 导出",14,TEXT));
    c.addView(text("全程离线，不执行文件。复杂反编译和快照解析交给电脑；不能确定的内容显示 unknown。",13,MUTED));
    button("开始本地检查",c,()->{if(selected==null){pick(FILE_PICK);return;}analyze();});
    if(result!=null)resultCard();
  }
  void remotePage(){
    LinearLayout c=card("连接你的电脑");
    if(connection==null)c.addView(text("暂无电脑或服务器也能使用本地功能。需要重分析时，在自己的电脑或云主机启动 REA 连接服务，再导入连接配置。支持公网 HTTPS、VPN 和局域网地址。",14,MUTED));
    else {c.addView(text(connection.optString("label","我的电脑"),17,TEXT));c.addView(text(connection.optString("url"),13,MUTED));c.addView(text("证书已固定 · 设备密钥由 Android Keystore 加密保存",12,GREEN));}
    button("导入电脑连接配置",c,()->pick(CONFIG_PICK));
    if(connection!=null){button("检查连接 / 刷新任务",c,()->refresh(true));button("移除此手机上的连接",c,()->new AlertDialog.Builder(this).setTitle("移除连接？").setMessage("仅清除手机密钥。电脑端任务继续运行；要撤销密钥，请在电脑移除对应设备。").setPositiveButton("移除",(d,w)->{ConnectionStore.clear(this);connection=null;jobs=new JSONArray();render();}).setNegativeButton("取消",null).show());}
    selectedCard();LinearLayout task=card("交给电脑处理");
    Spinner spinner=new Spinner(this);ArrayAdapter<String> adapter=new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,ACTION_LABELS);spinner.setAdapter(adapter);spinner.setSelection(actionIndex);spinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onItemSelected(android.widget.AdapterView<?> p,View v,int pos,long id){actionIndex=pos;}public void onNothingSelected(android.widget.AdapterView<?> p){}});task.addView(spinner);
    task.addView(text("最多 256 MiB / 文件。上传前核对文件；任务在电脑继续运行，手机切到后台后可回来刷新。",13,MUTED));
    button("上传并开始分析",task,()->submit(false));
    if(getPreferences(0).contains("pending")){
      button("恢复上次提交 / 查询是否已接收",task,()->submit(true));
      button("已核对电脑任务，清除恢复标记",task,()->new AlertDialog.Builder(this).setTitle("已核对电脑任务？").setMessage("清除此标记不会取消电脑任务。请先刷新列表确认上次提交的状态，避免之后手动重复启动分析。").setNegativeButton("返回核对",null).setPositiveButton("已核对，清除",(d,w)->{getPreferences(0).edit().remove("pending").commit();render();}).show());
    }
    LinearLayout list=card("电脑任务");if(jobs.length()==0)list.addView(text("连接后在这里查看进度和结果。",14,MUTED));
    for(int i=0;i<Math.min(30,jobs.length());i++){
      JSONObject job=jobs.optJSONObject(i);if(job==null)continue;String id=job.optString("id"),state=job.optString("state");
      list.addView(text(job.optString("tool")+"\n"+state+" · "+id.substring(0,Math.min(8,id.length())),14,TEXT));
      if(!job.optString("error").isEmpty())list.addView(text(job.optString("error"),12,MUTED));
      if(state.equals("running")||state.equals("queued"))button("请求取消",list,()->cancel(id));
      else button("读取结果",list,()->loadResult(id));
    }
    if(jobs.length()>30)list.addView(text("仅显示最近 30 项；完整记录保留在电脑。",12,MUTED));
    if(result!=null)resultCard();
  }
  void resultCard(){
    LinearLayout c=card("最近结果");
    try{
      button("导出完整 JSON",c,()->{try{exportText=pretty(result);Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"REA-result-"+System.currentTimeMillis()+".json");startActivityForResult(i,EXPORT);}catch(Exception e){toast(e.getMessage());}});
      String full=pretty(result);TextView v=text(full.length()>4000?full.substring(0,4000)+"\n…界面预览已截断，导出可查看完整记录。":full,12,TEXT);v.setTypeface(Typeface.MONOSPACE);v.setTextIsSelectable(true);c.addView(v);
    }catch(Exception e){c.addView(text("结果显示失败",14,MUTED));}
  }
  void historyPage(){
    LinearLayout c=card("手机保存的分析记录");c.addView(text("保存在应用私有目录。卸载前请导出；不会备份电脑密钥。",13,MUTED));File[] files=historyDir().listFiles((d,n)->n.endsWith(".json"));
    if(files==null||files.length==0)c.addView(text("尚无记录",14,MUTED));else{Arrays.sort(files,(a,b)->b.getName().compareTo(a.getName()));for(File f:files)button(f.getName().replace(".json",""),c,()->work("读取本地记录…",()->{Object data;try(InputStream in=new FileInputStream(f)){data=new JSONTokener(RemoteClient.readText(in,16*1024*1024)).nextValue();}final Object value=data;post(()->{result=value;note("已读取手机记录");render();});}));}
    if(files!=null&&files.length>0)button("清空手机历史记录",c,()->new AlertDialog.Builder(this).setTitle("清空手机记录？").setMessage("请先导出需要保留的结果。仅删除本应用保存的分析 JSON，不影响当前输入文件、电脑记录或连接密钥。").setNegativeButton("取消",null).setPositiveButton("清空",(d,w)->work("清理手机历史…",()->{File[] owned=historyDir().listFiles();if(owned!=null)for(File f:owned){if(!f.getName().matches("[0-9]+-[a-z-]+\\.json"))continue;if(!f.delete())throw new IOException("部分记录未能删除");}post(()->{note("手机历史记录已清空");render();});})).show());
    if(result!=null)resultCard();
  }
  String pretty(Object data)throws Exception{return data instanceof JSONObject?((JSONObject)data).toString(2):data instanceof JSONArray?((JSONArray)data).toString(2):String.valueOf(data);}
  File historyDir(){File d=new File(getFilesDir(),"history");d.mkdirs();return d;}
  void saveResult(Object value,String kind)throws Exception{
    byte[] bytes=pretty(value).getBytes("UTF-8");File[] files=historyDir().listFiles();long total=0;if(files!=null)for(File f:files)total+=f.length();
    if((files!=null&&files.length>=50)||total+bytes.length>64*1024*1024)throw new IOException("手机记录容量已满；结果仍可查看和导出，电脑原始记录保留");
    File file=new File(historyDir(),System.currentTimeMillis()+"-"+kind+".json");try(OutputStream out=new FileOutputStream(file)){out.write(bytes);}catch(Exception e){file.delete();throw e;}
  }
  File selectedFile()throws Exception{String name=selected.getString("file");if(!name.matches("[a-f0-9-]{36}\\.bin"))throw new IOException("本地文件引用无效");return new File(getFilesDir(),name);}
  void analyze(){work("本地检查中…",()->{JSONObject value=LocalAnalyzer.analyze(selectedFile(),selected);String saved="本地检查完成 · 未上传";try{saveResult(value,"local");}catch(Exception e){saved=e.getMessage();}final String label=saved;post(()->{result=value;note(label);render();});});}
  void pick(int request){Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(i,request);}
  @Override protected void onActivityResult(int request,int code,Intent intent){super.onActivityResult(request,code,intent);if(code!=RESULT_OK||intent==null||intent.getData()==null)return;Uri uri=intent.getData();
    if(request==FILE_PICK)work("读取所选文件并计算 SHA-256…",()->{
      String name="selected.bin";try(Cursor c=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst()&&!c.isNull(0))name=c.getString(0);}
      File next=new File(getFilesDir(),UUID.randomUUID()+".bin");JSONObject meta;try(InputStream in=getContentResolver().openInputStream(uri)){if(in==null)throw new IOException("无法读取所选文件");meta=LocalAnalyzer.copy(in,next,name);}
      if(!getPreferences(0).edit().putString("selected",meta.toString()).commit()){next.delete();throw new IOException("文件引用保存失败");}
      File previous=selected==null?null:selectedFile();if(previous!=null)previous.delete();post(()->{selected=meta;result=null;note("文件已就绪 · 仅存于手机");render();});
    });
    else if(request==CONFIG_PICK)work("读取连接配置…",()->{
      JSONObject config;try(InputStream in=getContentResolver().openInputStream(uri)){if(in==null)throw new IOException("无法读取配置");config=new JSONObject(RemoteClient.readText(in,65536));}RemoteClient.validate(config);
      post(()->new AlertDialog.Builder(this).setTitle("信任这台电脑？").setMessage(config.optString("url")+"\n\n证书 SHA-256\n"+config.optString("certificateSha256")+"\n\n仅导入由你自己的电脑生成的配置。连接文件含设备密钥，导入后请妥善保管或删除传输副本。").setNegativeButton("取消",null).setPositiveButton("保存连接",(d,w)->work("安全保存连接…",()->{ConnectionStore.save(this,config);post(()->{connection=config;jobs=new JSONArray();note("连接已保存，可检查电脑状态");render();});})).show());
    });
    else if(request==EXPORT){final String data=exportText;if(data==null){toast("待导出结果已失效，请重新导出");return;}work("导出结果…",()->{try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")){if(out==null)throw new IOException("无法写入目的地");out.write(data.getBytes("UTF-8"));}post(()->note("完整 JSON 已导出"));});}
  }
  RemoteClient client()throws Exception{if(connection==null)throw new IOException("请先导入电脑连接配置");return new RemoteClient(connection);}
  void refresh(boolean explicit){
    if(syncing||connection==null)return;syncing=true;final JSONObject captured=connection;
    if(explicit)note("连接电脑并刷新…");
    syncWorker.execute(()->{
      try{RemoteClient c=new RemoteClient(captured);JSONObject state=(JSONObject)c.request("GET","/v1/state",null,null,null);JSONArray list=(JSONArray)c.request("GET","/v1/jobs",null,null,null);String engine=state.getJSONObject("engine").optString("connection");post(()->{if(connection!=captured)return;boolean changed=!jobs.toString().equals(list.toString());jobs=list;nextPollAt=0;if(tab.equals("remote")){note("电脑引擎："+engine+" · 已同步 "+list.length()+" 个任务");if(explicit||changed)render();}});}
      catch(Exception e){post(()->{nextPollAt=System.currentTimeMillis()+30000;if(connection==captured&&tab.equals("remote")){note("电脑暂未连接："+e.getMessage()+"；本地功能仍可使用");if(explicit)toast(message);}});}
      finally{post(()->syncing=false);}
    });
  }
  void submit(boolean resume){work(resume?"恢复上次任务提交…":"上传所选文件，校验后交给电脑…",()->{
    RemoteClient c=client();JSONObject input;
    String identity=LocalAnalyzer.hex(java.security.MessageDigest.getInstance("SHA-256").digest(connection.getString("token").getBytes("UTF-8")));
    if(resume){JSONObject pending=new JSONObject(getPreferences(0).getString("pending","{}"));if(!identity.equals(pending.optString("connection")))throw new IOException("待恢复任务属于另一连接，请导入原连接配置");input=pending.getJSONObject("input");}
    else {if(getPreferences(0).contains("pending"))throw new IOException("上次提交尚未确认，请先使用恢复提交并检查电脑任务");if(selected==null)throw new IOException("请先选择文件");JSONObject file=(JSONObject)c.request("POST","/v1/files",null,selectedFile(),selected);input=new JSONObject().put("action",ACTION_IDS[actionIndex]).put("fileId",file.getString("id")).put("requestId",UUID.randomUUID().toString());if(!getPreferences(0).edit().putString("pending",new JSONObject().put("connection",identity).put("input",input).toString()).commit())throw new IOException("未能保存恢复信息，尚未提交任务");}
    c.request("POST","/v1/jobs",input,null,null);getPreferences(0).edit().remove("pending").commit();JSONArray list=(JSONArray)c.request("GET","/v1/jobs",null,null,null);post(()->{jobs=list;note("任务已被电脑接收，手机可切到后台");render();});
  });}
  void cancel(String id){work("向电脑请求取消…",()->{client().request("POST","/v1/jobs/"+id+"/cancel",new JSONObject(),null,null);JSONArray list=(JSONArray)client().request("GET","/v1/jobs",null,null,null);post(()->{jobs=list;note("已发送取消请求；资源清理以电脑返回的证据为准");render();});});}
  void loadResult(String id){work("读取电脑原始结果…",()->{Object value=client().request("GET","/v1/jobs/"+id+"/result",null,null,null);String saved="已读取完整返回值，unknown / partial 按原样保留";try{saveResult(value,"remote");}catch(Exception e){saved=e.getMessage();}final String label=saved;post(()->{result=value;note(label);render();});});}
}
