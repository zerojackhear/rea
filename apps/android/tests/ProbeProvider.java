package io.rea.mobile;
import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;
/** Test APK only: exports one fixed, source-owned JavaScript fixture, never arbitrary paths. */
public class ProbeProvider extends ContentProvider {
  static final byte[] BYTES="export function greet(name) { return 'hello ' + name; }\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
  public boolean onCreate(){return true;}
  public Cursor query(Uri uri,String[] p,String s,String[] a,String order){MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{"手机样本.js",BYTES.length});return c;}
  public String getType(Uri uri){return "application/javascript";}
  public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
    if(!uri.getPath().equals("/sample")||!mode.equals("r"))throw new FileNotFoundException();
    File f=new File(getContext().getFilesDir(),"sample.js");try(FileOutputStream out=new FileOutputStream(f)){out.write(BYTES);}catch(IOException e){throw new FileNotFoundException(e.getMessage());}
    return ParcelFileDescriptor.open(f,ParcelFileDescriptor.MODE_READ_ONLY);
  }
  public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
