package io.rea.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Observations only. Never extracts an archive or executes selected bytes. */
public final class LocalAnalyzer {
  public static final long MAX_FILE = 256L * 1024 * 1024;
  public static String hex(byte[] bytes) {
    StringBuilder s = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) s.append(String.format(Locale.ROOT, "%02x", b & 255)); return s.toString();
  }
  static void interrupted() throws InterruptedIOException {
    if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("操作已中止");
  }
  public static JSONObject copy(InputStream in, File output, String name) throws Exception {
    MessageDigest hash = MessageDigest.getInstance("SHA-256"); long size = 0;
    try (OutputStream out = new FileOutputStream(output)) {
      byte[] b = new byte[65536]; int n;
      while ((n = in.read(b)) != -1) { interrupted(); size += n; if (size > MAX_FILE) throw new IOException("文件超过手机端 256 MiB 上限"); hash.update(b,0,n); out.write(b,0,n); }
    } catch (Exception e) { output.delete(); throw e; }
    if (size == 0) { output.delete(); throw new IOException("所选文件为空"); }
    return new JSONObject().put("name", name).put("size",size).put("sha256",hex(hash.digest())).put("file",output.getName());
  }
  public static JSONObject analyze(File file, JSONObject identity) throws Exception {
    JSONObject report = new JSONObject().put("schema", "rea-mobile-observation-v1").put("kind","observation").put("createdAt",new Date().toInstant().toString()).put("source", new JSONObject(identity.toString()).put("file",JSONObject.NULL));
    byte[] prefix; try (InputStream in = new FileInputStream(file)) { prefix = new byte[(int)Math.min(file.length(),4 * 1024 * 1024)]; int p=0,n; while(p<prefix.length && (n=in.read(prefix,p,prefix.length-p))>0) { interrupted(); p+=n; } }
    String format = "unknown";
    if (starts(prefix, new byte[]{0x7f,69,76,70})) format="ELF";
    else if (starts(prefix,new byte[]{77,90})) format="MZ / PE candidate";
    else if (starts(prefix,new byte[]{100,101,120,10})) format="DEX";
    else if (starts(prefix,new byte[]{0,97,115,109})) format="WebAssembly";
    else if (starts(prefix,"SQLite format 3\u0000".getBytes("UTF-8"))) format="SQLite";
    else if (starts(prefix,new byte[]{80,75,3,4})) format="ZIP / APK candidate";
    else if (starts(prefix,new byte[]{(byte)0xca,(byte)0xfe,(byte)0xba,(byte)0xbe})) format="Java class / Mach-O candidate";
    report.put("formatObservation",format).put("headerHex",hex(Arrays.copyOf(prefix,Math.min(64,prefix.length))));
    JSONArray strings = new JSONArray(); int start=-1;
    for (int i=0;i<=prefix.length && strings.length()<500;i++) {
      int v=i<prefix.length ? prefix[i]&255 : 0;
      if(v>=32 && v<=126) { if(start<0) start=i; }
      else if(start>=0) { if(i-start>=6) strings.put(new JSONObject().put("offset",start).put("text",new String(prefix,start,Math.min(200,i-start),"US-ASCII")).put("truncated",i-start>200)); start=-1; }
    }
    report.put("strings",strings).put("stringCoverage",new JSONObject().put("scannedPrefixBytes",prefix.length).put("fileBytes",file.length()).put("limit",500).put("complete",false).put("note","仅 ASCII 可打印片段，最多扫描前 4 MiB；不代表完整字符串或程序语义"));
    if(format.startsWith("ZIP")) {
      try { report.put("archive",archive(file)); }
      catch(Exception e) { report.put("archive",new JSONObject().put("status","unknown").put("reason",e.getMessage())); }
    }
    report.put("limitations",new JSONArray().put("未执行文件，未反编译代码，未验证 APK 签名").put("二进制 AndroidManifest.xml 的权限与包名需电脑端解码").put("格式来自文件头观察，候选格式不等于有效性验证"));
    return report;
  }
  static boolean starts(byte[] a, byte[] b) { if(a.length<b.length)return false; for(int i=0;i<b.length;i++)if(a[i]!=b[i])return false; return true; }
  static long u32(byte[] b,int p) { return (b[p]&255L)|((b[p+1]&255L)<<8)|((b[p+2]&255L)<<16)|((b[p+3]&255L)<<24); }
  static int u16(byte[] b,int p) { return (b[p]&255)|((b[p+1]&255)<<8); }
  static JSONObject archive(File file) throws Exception {
    // Bound the central-directory representation before ZipFile allocates its index.
    try(RandomAccessFile in=new RandomAccessFile(file,"r")) {
      byte[] tail=new byte[(int)Math.min(file.length(),65557)]; in.seek(file.length()-tail.length); in.readFully(tail); int e=-1;
      for(int i=tail.length-22;i>=0;i--) if(u32(tail,i)==0x06054b50L && i+22+u16(tail,i+20)==tail.length) { e=i; break; }
      if(e<0) throw new IOException("缺少完整 ZIP 目录尾部");
      if(u16(tail,e+4)!=0 || u16(tail,e+6)!=0 || u16(tail,e+8)!=u16(tail,e+10)) throw new IOException("分卷 ZIP 不在本地支持范围");
      if(u16(tail,e+10)>20000 || u32(tail,e+12)>4*1024*1024 || u32(tail,e+16)==0xffffffffL) throw new IOException("ZIP64 或目录超过本地容量限制，保留 unknown");
    }
    JSONArray entries=new JSONArray(), abis=new JSONArray(); Set<String> seen=new LinkedHashSet<>(); int count=0; boolean manifest=false,dex=false;
    try(ZipFile zip=new ZipFile(file)) {
      Enumeration<? extends ZipEntry> all=zip.entries();
      while(all.hasMoreElements()) { interrupted(); ZipEntry e=all.nextElement(); count++; String n=e.getName();
        if(n.equals("AndroidManifest.xml"))manifest=true; if(n.matches("classes[0-9]*\\.dex"))dex=true;
        if(n.startsWith("lib/") && n.endsWith(".so")) { String[] parts=n.split("/"); if(parts.length==3)seen.add(parts[1]); }
        if(entries.length()<500) entries.put(new JSONObject().put("name",n).put("uncompressedBytes",e.getSize()<0?JSONObject.NULL:e.getSize()).put("compressedBytes",e.getCompressedSize()<0?JSONObject.NULL:e.getCompressedSize()).put("directory",e.isDirectory()));
      }
    }
    for(String abi:seen)abis.put(abi);
    return new JSONObject().put("status",count<=500?"complete-directory":"partial-directory").put("entryCount",count).put("entries",entries).put("hasAndroidManifest",manifest).put("hasDex",dex).put("nativeAbis",abis).put("note","只检查目录；压缩内容、CRC、签名和 APK 可安装性未验证");
  }
}
