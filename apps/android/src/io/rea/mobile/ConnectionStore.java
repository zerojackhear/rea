package io.rea.mobile;
import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class ConnectionStore {
  private static final String ALIAS="rea-mobile-connection-v1";
  static SecretKey key() throws Exception {
    KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
    if(!ks.containsAlias(ALIAS)) { KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore"); gen.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); gen.generateKey(); }
    return (SecretKey)ks.getKey(ALIAS,null);
  }
  static void save(Context c, JSONObject value) throws Exception {
    RemoteClient.validate(value); Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,key());
    String data=Base64.encodeToString(cipher.doFinal(value.toString().getBytes("UTF-8")),Base64.NO_WRAP);
    String iv=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP);
    if(!c.getSharedPreferences("connection",0).edit().putString("data",data).putString("iv",iv).commit()) throw new Exception("连接配置保存失败");
  }
  static JSONObject load(Context c) throws Exception {
    android.content.SharedPreferences p=c.getSharedPreferences("connection",0); String data=p.getString("data",null); if(data==null)return null;
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p.getString("iv",""),Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(data,Base64.NO_WRAP)),"UTF-8"));
  }
  static void clear(Context c) { c.getSharedPreferences("connection",0).edit().clear().commit(); }
}
