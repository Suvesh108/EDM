package io.vortexdownloader.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "VortexNative")
public class VortexNativePlugin extends Plugin {

    public static String pendingSharedUrl = null;

    @PluginMethod
    public void getInitialSharedUrl(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", pendingSharedUrl != null ? pendingSharedUrl : "");
        pendingSharedUrl = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        if (getActivity() != null) {
            getActivity().finish();
        }
        call.resolve();
    }

    /**
     * Native background download using Android DownloadManager.
     * ZERO JavaScript heap memory overhead, survives app sleep, shows native progress tray.
     */
    @PluginMethod
    public void downloadWithManager(PluginCall call) {
        String downloadUrl = call.getString("url");
        String filename = call.getString("filename", "download_" + System.currentTimeMillis());
        String title = call.getString("title", filename);
        String mimeType = call.getString("mimeType", "*/*");

        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("url is required");
            return;
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(downloadUrl));
            request.setTitle(title);
            request.setDescription("Vortex Downloader High-Speed Stream");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            
            // Add browser stealth headers to evade bot/CDN block
            request.addRequestHeader("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36");
            request.addRequestHeader("Accept", "*/*");

            // Allow mobile network and Wi-Fi
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            // Set destination in public Download folder: Download/VortexDownloader/{filename}
            File vortexDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VortexDownloader");
            if (!vortexDir.exists()) {
                vortexDir.mkdirs();
            }
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "VortexDownloader/" + filename);

            if (mimeType != null && !mimeType.equals("*/*")) {
                request.setMimeType(mimeType);
            }

            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            long downloadId = dm.enqueue(request);

            File targetFile = new File(vortexDir, filename);

            JSObject res = new JSObject();
            res.put("success", true);
            res.put("downloadId", downloadId);
            res.put("filePath", targetFile.getAbsolutePath());
            res.put("filename", filename);
            call.resolve(res);

        } catch (Exception e) {
            call.reject("Failed to schedule DownloadManager task: " + e.getMessage());
        }
    }

    /**
     * Native direct background stream downloader with live progress updates.
     * Directly streams bytes from network into the target file on disk, avoiding Base64 and memory spikes.
     */
    @PluginMethod
    public void downloadDirectStream(PluginCall call) {
        String downloadUrl = call.getString("url");
        String filename = call.getString("filename", "download_" + System.currentTimeMillis());
        String title = call.getString("title", filename);
        String mimeType = call.getString("mimeType", "*/*");

        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("url is required");
            return;
        }

        new Thread(() -> {
            HttpURLConnection conn = null;
            InputStream input = null;
            FileOutputStream output = null;
            try {
                File vortexDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VortexDownloader");
                if (!vortexDir.exists()) {
                    vortexDir.mkdirs();
                }

                File outputFile = new File(vortexDir, filename);
                if (outputFile.exists()) {
                    String baseName = filename.contains(".") ? filename.substring(0, filename.lastIndexOf('.')) : filename;
                    String ext = filename.contains(".") ? filename.substring(filename.lastIndexOf('.')) : "";
                    outputFile = new File(vortexDir, baseName + "_" + System.currentTimeMillis() + ext);
                }

                URL url = new URL(downloadUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36");
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                conn.connect();

                // Handle redirects
                int status = conn.getResponseCode();
                int redirects = 0;
                while ((status == HttpURLConnection.HTTP_MOVED_TEMP ||
                        status == HttpURLConnection.HTTP_MOVED_PERM ||
                        status == HttpURLConnection.HTTP_SEE_OTHER ||
                        status == 307 || status == 308) && redirects < 5) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    url = new URL(loc);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36");
                    conn.setRequestProperty("Accept", "*/*");
                    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                    conn.connect();
                    status = conn.getResponseCode();
                    redirects++;
                }

                if (status != HttpURLConnection.HTTP_OK && status != 206) {
                    call.reject("HTTP error: " + status);
                    return;
                }

                long totalBytes = conn.getContentLengthLong();
                input = conn.getInputStream();
                output = new FileOutputStream(outputFile);

                byte[] buffer = new byte[65536]; // 64 KB buffer
                int bytesRead;
                long totalDownloaded = 0;
                long lastProgressTime = 0;
                long startTime = System.currentTimeMillis();

                while ((bytesRead = input.read(buffer)) != -1) {
                    output.write(buffer, 0, bytesRead);
                    totalDownloaded += bytesRead;

                    long now = System.currentTimeMillis();
                    if (now - lastProgressTime > 250) {
                        int percent = totalBytes > 0 ? (int) ((totalDownloaded * 100) / totalBytes) : 0;
                        double elapsedSec = (now - startTime) / 1000.0;
                        double speedMB = elapsedSec > 0 ? (totalDownloaded / elapsedSec) / (1024.0 * 1024.0) : 0;
                        String speedStr = String.format("%.1f MB/s", speedMB);

                        JSObject prog = new JSObject();
                        prog.put("filename", filename);
                        prog.put("percent", percent);
                        prog.put("downloadedBytes", totalDownloaded);
                        prog.put("totalBytes", totalBytes);
                        prog.put("speed", speedStr);
                        notifyListeners("nativeProgress", prog);
                        lastProgressTime = now;
                    }
                }

                output.flush();

                // Scan file into Android MediaStore so it immediately appears in Gallery, VLC, and Music players
                MediaScannerConnection.scanFile(
                    getContext(),
                    new String[]{outputFile.getAbsolutePath()},
                    new String[]{mimeType},
                    null
                );

                JSObject res = new JSObject();
                res.put("success", true);
                res.put("filePath", outputFile.getAbsolutePath());
                res.put("filename", outputFile.getName());
                res.put("totalBytes", totalDownloaded);
                call.resolve(res);

            } catch (Exception e) {
                call.reject("Direct stream download failed: " + e.getMessage());
            } finally {
                try { if (output != null) output.close(); } catch (Exception ignored) {}
                try { if (input != null) input.close(); } catch (Exception ignored) {}
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /**
     * Launch default Android app to open/play the downloaded file.
     */
    @PluginMethod
    public void openFile(PluginCall call) {
        String filePath = call.getString("filePath");
        String mimeType = call.getString("mimeType");

        if (filePath == null || filePath.isEmpty()) {
            call.reject("filePath is required");
            return;
        }

        try {
            File file = resolveFile(filePath);
            if (!file.exists()) {
                call.reject("File does not exist: " + file.getAbsolutePath());
                return;
            }

            if (mimeType == null || mimeType.isEmpty() || mimeType.equals("*/*")) {
                mimeType = getMimeType(file.getAbsolutePath());
            }

            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            Intent chooser = Intent.createChooser(intent, "Open with...");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);

        } catch (Exception e) {
            call.reject("Could not open file: " + e.getMessage());
        }
    }

    /**
     * Share downloaded file via Android system share sheet.
     */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String filePath = call.getString("filePath");
        String title = call.getString("title", "Share File");
        String mimeType = call.getString("mimeType");

        if (filePath == null || filePath.isEmpty()) {
            call.reject("filePath is required");
            return;
        }

        try {
            File file = resolveFile(filePath);
            if (!file.exists()) {
                call.reject("File does not exist: " + file.getAbsolutePath());
                return;
            }

            if (mimeType == null || mimeType.isEmpty() || mimeType.equals("*/*")) {
                mimeType = getMimeType(file.getAbsolutePath());
            }

            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );

            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.putExtra(Intent.EXTRA_SUBJECT, title);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(intent, "Share via...");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);

        } catch (Exception e) {
            call.reject("Could not share file: " + e.getMessage());
        }
    }

    private File resolveFile(String filePath) {
        if (filePath.startsWith("file://")) {
            filePath = filePath.substring(7);
        }
        File file = new File(filePath);
        if (!file.isAbsolute()) {
            File vortexDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VortexDownloader");
            file = new File(vortexDir, filePath);
        }
        return file;
    }

    private String getMimeType(String path) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(path);
        if (ext == null || ext.isEmpty()) {
            int dot = path.lastIndexOf('.');
            if (dot >= 0) ext = path.substring(dot + 1);
        }
        if (ext != null) {
            String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
            if (type != null) return type;
        }
        return "*/*";
    }
}
