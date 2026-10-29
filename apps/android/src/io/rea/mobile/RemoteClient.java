package io.rea.mobile;
import org.json.*;
import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.*;
import javax.net.ssl.*;

final class RemoteClient {
  final JSONObject config; final SSLSocketFactory sockets;
  static void validate(JSONObject c) throws Exception {
    URI u=new URI(c.getString("url"));
    if(c.getInt("protocol")!=1 || !"https".equals(u.getScheme()) || u.getHost()==null || u.getUserInfo()!=null || u.getQuery()!=null || u.getFragment()!=null || !(u.getPath().isEmpty()||u.getPath().equals("/")) || u.getPort()==0 || u.getPort()>65535 || !c.getString("certificateSha256").matches("[a-f0-9]{64}") || !c.getString("token").matches("[a-f0-9]{64}")) throw new IOException("连接配置无效：需要 HTTPS 根地址、证书指纹和设备密钥");
  }
  RemoteClient(JSONObject c) throws Exception {
    validate(c); config=new JSONObject(c.toString()); final String pin=c.getString("certificateSha256");
    X509TrustManager trust=new X509TrustManager() {
      public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
      public void checkClientTrusted(X509Certificate[] chain,String auth) throws CertificateException {throw new CertificateException("client TLS unsupported");}
      public void checkServerTrusted(X509Certificate[] chain,String auth) throws CertificateException {
        if(chain==null||chain.length==0)throw new CertificateException("缺少服务器证书"); chain[0].checkValidity();
        try {if(!LocalAnalyzer.hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded())).equals(pin))throw new CertificateException("电脑证书指纹不匹配");}catch(GeneralSecurityException e){throw new CertificateException(e);}
      }
    };
    SSLContext context=SSLContext.getInstance("TLS"); context.init(null,new TrustManager[]{trust},new SecureRandom()); sockets=context.getSocketFactory();
  }
  Object request(String method,String path,JSONObject json,File file,JSONObject metadata) throws Exception {
    if(!path.startsWith("/v1/"))throw new IOException("无效的接口");
    String base=config.getString("url").replaceAll("/+$","");
    HttpsURLConnection c=(HttpsURLConnection)new URL(base+path).openConnection();
    c.setSSLSocketFactory(sockets);
    // Explicit certificate pin is the server identity, including VPN/IP URLs with no public CA name.
    c.setHostnameVerifier((host,session)->{
      try{return host.equals(new URI(base).getHost()) && LocalAnalyzer.hex(MessageDigest.getInstance("SHA-256").digest(session.getPeerCertificates()[0].getEncoded())).equals(config.getString("certificateSha256"));}catch(Exception e){return false;}
    });
    c.setConnectTimeout(15000); c.setReadTimeout(60000); c.setInstanceFollowRedirects(false); c.setRequestMethod(method);
    c.setRequestProperty("Authorization","Bearer "+config.getString("token")); c.setRequestProperty("Accept","application/json");
    try {
      if(file!=null) {
        c.setDoOutput(true); c.setFixedLengthStreamingMode(file.length()); c.setRequestProperty("Content-Type","application/octet-stream"); c.setRequestProperty("X-SHA256",metadata.getString("sha256")); c.setRequestProperty("X-File-Name",URLEncoder.encode(metadata.getString("name"),"UTF-8").replace("+","%20"));
        try(InputStream in=new FileInputStream(file); OutputStream out=c.getOutputStream()) { byte[] b=new byte[65536]; int n; while((n=in.read(b))!=-1){LocalAnalyzer.interrupted();out.write(b,0,n);} }
      } else if(json!=null) {
        byte[] bytes=json.toString().getBytes("UTF-8"); c.setDoOutput(true); c.setRequestProperty("Content-Type","application/json"); c.setFixedLengthStreamingMode(bytes.length); try(OutputStream out=c.getOutputStream()){out.write(bytes);}
      }
      int status=c.getResponseCode(); if(status>=300&&status<400)throw new IOException("拒绝服务器重定向，请核对连接地址");
      InputStream input=status>=400?c.getErrorStream():c.getInputStream(); if(input==null)throw new IOException("服务器返回 HTTP "+status);
      String text; try(InputStream in=input){text=readText(in,16*1024*1024);}
      Object result=new JSONTokener(text).nextValue();
      if(status>=400)throw new IOException(result instanceof JSONObject?((JSONObject)result).optString("error","HTTP "+status):"HTTP "+status);
      return result;
    } finally { c.disconnect(); }
  }
  static String readText(InputStream in,int limit) throws Exception { ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] b=new byte[16384]; int n; while((n=in.read(b))!=-1){LocalAnalyzer.interrupted();if(out.size()+n>limit)throw new IOException("接收数据超过容量限制");out.write(b,0,n);} return out.toString("UTF-8"); }
}
