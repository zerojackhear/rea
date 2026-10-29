package io.rea.mobile;
import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Runs against the signed production APK and a real HTTPS -> REA stdio MCP service. */
public class Probe extends Instrumentation {
  JSONArray passed=new JSONArray();MainActivity activity;
  void check(boolean ok,String label)throws Exception{if(!ok)throw new Exception(label);passed.put(label);}
  public void onCreate(Bundle args){super.onCreate(args);start();}
  void idle()throws Exception{for(int i=0;i<300;i++){Thread.sleep(100);waitForIdleSync();if(!activity.busy)return;}throw new Exception("activity work timed out");}
  Object analyzeRemote(RemoteClient c,String action,File source,String name)throws Exception{
    File copy=new File(getTargetContext().getCacheDir(),"probe-upload.bin");JSONObject meta;
    try(InputStream in=new FileInputStream(source)){meta=LocalAnalyzer.copy(in,copy,name);}
    JSONObject file=(JSONObject)c.request("POST","/v1/files",null,copy,meta);
    JSONObject input=new JSONObject().put("action",action).put("fileId",file.getString("id")).put("requestId",UUID.randomUUID().toString());
    String id=((JSONObject)c.request("POST","/v1/jobs",input,null,null)).getString("id");JSONObject row=null;
    for(int i=0;i<180;i++){JSONArray jobs=(JSONArray)c.request("GET","/v1/jobs",null,null,null);for(int j=0;j<jobs.length();j++)if(jobs.getJSONObject(j).getString("id").equals(id))row=jobs.getJSONObject(j);if(row!=null&&!Arrays.asList("queued","running").contains(row.optString("state")))break;Thread.sleep(1000);}
    check(row!=null&&row.optString("state").equals("completed"),"real "+action+" workflow completed: "+(row==null?"missing":row.optString("state")+" "+row.optString("error")));
    Object value=c.request("GET","/v1/jobs/"+id+"/result",null,null,null);check(value.toString().contains("evidence_id"),action+" original Evidence returned");return value;
  }
  public void onStart(){Bundle output=new Bundle();try{
    JSONObject config;try(InputStream in=getContext().getAssets().open("connection.json")){config=new JSONObject(RemoteClient.readText(in,65536));}
    ConnectionStore.save(getTargetContext(),config);
    check(ConnectionStore.load(getTargetContext()).getString("token").equals(config.getString("token")),"Android Keystore connection round trip");
    check(!getTargetContext().getSharedPreferences("connection",0).getString("data","").contains(config.getString("token")),"credential not plaintext in preferences");
    Intent launch=new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);activity=(MainActivity)startActivitySync(launch);
    runOnMainSync(()->activity.onActivityResult(MainActivity.FILE_PICK,Activity.RESULT_OK,new Intent().setData(Uri.parse("content://io.rea.mobile.probe.files/sample"))));idle();
    check(activity.selected!=null&&activity.selected.getString("name").equals("手机样本.js"),"content URI import preserves Unicode name");
    check(activity.selected.getString("sha256").equals(LocalAnalyzer.hex(MessageDigest.getInstance("SHA-256").digest(ProbeProvider.BYTES))),"selected content SHA-256 matches bytes");
    runOnMainSync(()->activity.analyze());idle();check(activity.result instanceof JSONObject&&((JSONObject)activity.result).getString("kind").equals("observation"),"native offline analysis and persisted result");
    File zip=new File(getTargetContext().getCacheDir(),"local.zip");try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(zip))){for(String n:new String[]{"AndroidManifest.xml","classes.dex","lib/arm64-v8a/libapp.so"}){out.putNextEntry(new ZipEntry(n));out.write(new byte[]{1,2,3});out.closeEntry();}}
    JSONObject a=LocalAnalyzer.archive(zip);check(a.getInt("entryCount")==3&&a.getBoolean("hasAndroidManifest")&&a.getJSONArray("nativeAbis").getString(0).equals("arm64-v8a"),"APK directory and ABI observations without extraction");
    try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(zip))){out.putNextEntry(new ZipEntry("../never-extract"));out.write(42);out.closeEntry();}
    JSONObject suspicious=LocalAnalyzer.analyze(zip,new JSONObject().put("name","suspicious.zip"));check(suspicious.getJSONObject("archive").getString("status").equals("unknown"),"Android restricted ZIP name remains unknown");
    check(!new File(getTargetContext().getCacheDir().getParentFile(),"never-extract").exists(),"archive traversal entry is never extracted");
    try(FileOutputStream out=new FileOutputStream(zip)){out.write(new byte[]{80,75,3,4});}
    check(LocalAnalyzer.analyze(zip,new JSONObject().put("name","broken.zip")).getJSONObject("archive").getString("status").equals("unknown"),"malformed ZIP remains unknown");
    JSONObject insecure=new JSONObject(config.toString()).put("url","http://10.0.2.2:8443");boolean rejected=false;try{new RemoteClient(insecure);}catch(Exception expected){rejected=true;}check(rejected,"cleartext endpoint rejected");
    RemoteClient c=new RemoteClient(config);JSONObject state=(JSONObject)c.request("GET","/v1/state",null,null,null);
    for(int i=0;i<60&&!state.getJSONObject("engine").optString("connection").equals("ready");i++){Thread.sleep(1000);state=(JSONObject)c.request("GET","/v1/state",null,null,null);}
    check(state.getJSONObject("engine").getString("connection").equals("ready"),"real REA MCP engine ready through HTTPS");
    rejected=false;try{new RemoteClient(new JSONObject(config.toString()).put("certificateSha256",String.join("",Collections.nCopies(64,"0")))).request("GET","/v1/state",null,null,null);}catch(Exception expected){rejected=true;}check(rejected,"wrong certificate pin rejected on Android");
    rejected=false;try{new RemoteClient(new JSONObject(config.toString()).put("token",String.join("",Collections.nCopies(64,"0")))).request("GET","/v1/state",null,null,null);}catch(Exception expected){rejected=true;}check(rejected,"revoked or wrong device credential rejected");
    JSONObject uploaded=(JSONObject)c.request("POST","/v1/files",null,activity.selectedFile(),activity.selected);
    check(uploaded.getString("sha256").equals(activity.selected.getString("sha256")),"Android to PC upload integrity");
    JSONObject input=new JSONObject().put("action","javascript").put("fileId",uploaded.getString("id")).put("requestId",UUID.randomUUID().toString());
    JSONObject job=(JSONObject)c.request("POST","/v1/jobs",input,null,null);String id=job.getString("id");
    JSONObject repeated=(JSONObject)new RemoteClient(config).request("POST","/v1/jobs",input,null,null);check(repeated.getString("id").equals(id),"reconnected client retries same job without duplicate execution");
    JSONObject done=null;
    for(int i=0;i<120;i++){JSONArray jobs=(JSONArray)c.request("GET","/v1/jobs",null,null,null);for(int j=0;j<jobs.length();j++){JSONObject row=jobs.getJSONObject(j);if(row.getString("id").equals(id))done=row;}if(done!=null&&!Arrays.asList("running","queued").contains(done.optString("state")))break;Thread.sleep(1000);}
    check(done!=null&&done.getString("state").equals("completed"),"real JavaScript analysis completed: "+(done==null?"missing":done.optString("state")));
    Object value=c.request("GET","/v1/jobs/"+id+"/result",null,null,null);check(value.toString().contains("evidence_id"),"original MCP Evidence returned to Android");
    Object apk=analyzeRemote(c,"android",new File(getTargetContext().getApplicationInfo().sourceDir),"rea-self.apk");check(apk.toString().contains("io.rea.mobile"),"JADX decoded the actual delivered Android package identity");
    File wasm=new File(getTargetContext().getCacheDir(),"minimal.wasm");try(FileOutputStream out=new FileOutputStream(wasm)){out.write(new byte[]{0,97,115,109,1,0,0,0});}analyzeRemote(c,"wasm",wasm,"minimal.wasm");
    File db=new File(getTargetContext().getCacheDir(),"sample.sqlite");android.database.sqlite.SQLiteDatabase database=android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(db,null);database.execSQL("CREATE TABLE IF NOT EXISTS sample (id INTEGER, label TEXT)");database.close();Object sqlite=analyzeRemote(c,"sqlite",db,"sample.sqlite");check(sqlite.toString().contains("sample"),"real SQLite table observation returned");
    final JSONObject originalConnection=activity.connection;
    runOnMainSync(()->{try{activity.connection=new JSONObject(originalConnection.toString()).put("url","https://10.0.2.2:18444");activity.refresh(false);activity.analyze();}catch(Exception e){throw new RuntimeException(e);}});idle();check(activity.result instanceof JSONObject&&((JSONObject)activity.result).optString("kind").equals("observation"),"offline local analysis remains available when backend is unavailable");runOnMainSync(()->activity.connection=originalConnection);
    activity.saveResult(value,"probe-remote");runOnMainSync(()->{activity.result=value;activity.tab="remote";activity.render();});
    output.putString("report",new JSONObject().put("passed",passed).put("jobId",id).put("scope","Android 14 x86_64 emulator -> Windows x64 TLS -> real REA MCP; not a physical ARM or public Internet test").toString());finish(Activity.RESULT_OK,output);
  }catch(Throwable e){output.putString("report",new JSONObject().toString());output.putString("passed",passed.toString());output.putString("error",e.toString());finish(Activity.RESULT_CANCELED,output);}}
}
