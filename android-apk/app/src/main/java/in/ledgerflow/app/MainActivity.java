package in.ledgerflow.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.telephony.SmsManager;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    private static final String BUNDLED_HOST = "appassets.androidplatform.net";
    private static final String BUNDLED_ENTRY_URL = "https://" + BUNDLED_HOST + "/index.html";

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri pendingCameraCaptureUri;
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private ActivityResultLauncher<String[]> runtimePermissionsLauncher;
    private PermissionRequest pendingWebPermissionRequest;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private WebViewAssetLoader assetLoader;
    private final ExecutorService emailExecutor = Executors.newSingleThreadExecutor();
    private String allowedAppHost = BUNDLED_HOST;
    private String entryUrl = BUNDLED_ENTRY_URL;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(BUNDLED_HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        // Always boot the bundled LedgerFlow UI locally (zero blank screen / 503 errors).
        // Live Cloud SQL / PostgreSQL sync is routed over HTTPS via BuildConfig.API_BASE_URL.
        entryUrl = BUNDLED_ENTRY_URL;
        allowedAppHost = BUNDLED_HOST;

        runtimePermissionsLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestMultiplePermissions(),
                results -> {
                    if (pendingWebPermissionRequest != null) {
                        boolean cameraGranted = isPermissionGranted(Manifest.permission.CAMERA);
                        if (cameraGranted) {
                            pendingWebPermissionRequest.grant(pendingWebPermissionRequest.getResources());
                        } else {
                            pendingWebPermissionRequest.deny();
                        }
                        pendingWebPermissionRequest = null;
                    }
                    if (pendingGeoCallback != null && pendingGeoOrigin != null) {
                        boolean locationGranted = isPermissionGranted(Manifest.permission.ACCESS_FINE_LOCATION)
                                || isPermissionGranted(Manifest.permission.ACCESS_COARSE_LOCATION);
                        pendingGeoCallback.invoke(pendingGeoOrigin, locationGranted, false);
                        pendingGeoCallback = null;
                        pendingGeoOrigin = null;
                    }
                }
        );

        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (filePathCallback == null) {
                        pendingCameraCaptureUri = null;
                        return;
                    }
                    Uri[] results = null;
                    if (result.getResultCode() == Activity.RESULT_OK) {
                        Intent data = result.getData();
                        if (data != null && (data.getData() != null || data.getClipData() != null)) {
                            results = WebChromeClient.FileChooserParams.parseResult(
                                    result.getResultCode(),
                                    data
                            );
                        } else if (pendingCameraCaptureUri != null) {
                            results = new Uri[]{pendingCameraCaptureUri};
                        }
                    }
                    filePathCallback.onReceiveValue(results);
                    filePathCallback = null;
                    pendingCameraCaptureUri = null;
                }
        );

        swipeRefresh = new SwipeRefreshLayout(this);
        swipeRefresh.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        swipeRefresh.setColorSchemeColors(Color.parseColor("#1D358F"), Color.parseColor("#0B1220"));

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.setBackgroundColor(Color.parseColor("#0B1220"));

        swipeRefresh.addView(webView);
        swipeRefresh.setOnChildScrollUpCallback((parent, child) -> webView.getScrollY() > 0);
        swipeRefresh.setOnRefreshListener(() -> webView.reload());
        setContentView(swipeRefresh);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(), "LedgerFlowAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && BUNDLED_HOST.equalsIgnoreCase(uri.getHost())) {
                    WebResourceResponse response = assetLoader.shouldInterceptRequest(uri);
                    if (response != null) {
                        return response;
                    }
                    // SPA route fallback to index.html for extension-less paths
                    String path = uri.getPath();
                    if (path == null || path.equals("/") || !path.contains(".")) {
                        return assetLoader.shouldInterceptRequest(Uri.parse(BUNDLED_ENTRY_URL));
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) {
                    return false;
                }
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
                if ("mailto".equals(scheme)
                        || "tel".equals(scheme)
                        || "sms".equals(scheme)
                        || "smsto".equals(scheme)
                        || "mms".equals(scheme)
                        || "mmsto".equals(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                        // Ignore if no handler is installed
                    }
                    return true;
                }
                if (!"https".equals(scheme) && !"http".equals(scheme)) {
                    return true;
                }
                String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
                if (host.equals(BUNDLED_HOST)
                        || host.equals(allowedAppHost)
                        || host.endsWith(".run.app")
                        || host.endsWith(".firebaseapp.com")
                        || host.endsWith(".web.app")) {
                    return false;
                }
                // Open external links (e.g., Google Drive web links) in the system browser
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    swipeRefresh.setRefreshing(false);
                    String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
                    if (!failingUrl.startsWith("https://" + BUNDLED_HOST)) {
                        view.loadUrl(BUNDLED_ENTRY_URL);
                    }
                }
            }

            @Override
            public void onReceivedHttpError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceResponse errorResponse
            ) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request != null && request.isForMainFrame() && errorResponse != null) {
                    int status = errorResponse.getStatusCode();
                    String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
                    if (status >= 500 && !failingUrl.startsWith("https://" + BUNDLED_HOST)) {
                        swipeRefresh.setRefreshing(false);
                        view.loadUrl(BUNDLED_ENTRY_URL);
                    }
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefresh.setRefreshing(false);
                // Track anchor download filenames for blob: exports (PDF/Excel/JSON)
                String hookScript =
                        "(function(){"
                                + "if(window.__lfBlobHooked)return;"
                                + "window.__lfBlobHooked=true;"
                                + "window.__lfBlobNames={};"
                                + "var origClick=HTMLAnchorElement.prototype.click;"
                                + "HTMLAnchorElement.prototype.click=function(){"
                                + "try{if(this.href&&this.href.indexOf('blob:')===0&&this.download){"
                                + "window.__lfBlobNames[this.href]=this.download;}}catch(e){}"
                                + "return origClick.apply(this,arguments);"
                                + "};"
                                + "})();";
                view.evaluateJavascript(hookScript, null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    String[] requested = request.getResources();
                    boolean needsCamera = false;
                    for (String res : requested) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                            needsCamera = true;
                            break;
                        }
                    }
                    if (!needsCamera || isPermissionGranted(Manifest.permission.CAMERA)) {
                        request.grant(requested);
                    } else {
                        if (pendingWebPermissionRequest != null) {
                            pendingWebPermissionRequest.deny();
                        }
                        pendingWebPermissionRequest = request;
                        runtimePermissionsLauncher.launch(new String[]{Manifest.permission.CAMERA});
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin,
                    GeolocationPermissions.Callback callback
            ) {
                if (isPermissionGranted(Manifest.permission.ACCESS_FINE_LOCATION)
                        || isPermissionGranted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    runtimePermissionsLauncher.launch(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    });
                }
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                pendingCameraCaptureUri = null;

                try {
                    boolean acceptsImages = false;
                    String[] acceptTypes = fileChooserParams.getAcceptTypes();
                    if (acceptTypes == null || acceptTypes.length == 0) {
                        acceptsImages = true;
                    } else {
                        for (String t : acceptTypes) {
                            if (t == null || t.isEmpty() || t.contains("image") || t.equals("*/*")) {
                                acceptsImages = true;
                                break;
                            }
                        }
                    }

                    Intent cameraIntent = null;
                    if ((acceptsImages || fileChooserParams.isCaptureEnabled())
                            && isPermissionGranted(Manifest.permission.CAMERA)) {
                        cameraIntent = createCameraCaptureIntent();
                    }

                    if (fileChooserParams.isCaptureEnabled() && cameraIntent != null) {
                        fileChooserLauncher.launch(cameraIntent);
                        return true;
                    }

                    Intent contentIntent = fileChooserParams.createIntent();
                    if (cameraIntent != null) {
                        Intent chooser = Intent.createChooser(contentIntent, "Select file or take photo");
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
                        fileChooserLauncher.launch(chooser);
                    } else {
                        fileChooserLauncher.launch(contentIntent);
                    }
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    pendingCameraCaptureUri = null;
                    Toast.makeText(MainActivity.this, "Unable to open camera or file picker.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null) {
                return;
            }
            if (url.startsWith("blob:")) {
                String fallbackName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                String js =
                        "(function(blobUrl, fallbackName, fallbackMime){"
                                + "var name=(window.__lfBlobNames&&window.__lfBlobNames[blobUrl])||fallbackName;"
                                + "fetch(blobUrl).then(function(r){return r.blob();}).then(function(b){"
                                + "var reader=new FileReader();"
                                + "reader.onloadend=function(){"
                                + "if(window.LedgerFlowAndroid&&typeof reader.result==='string'){"
                                + "window.LedgerFlowAndroid.saveBase64File(reader.result, name, b.type||fallbackMime||'application/octet-stream');"
                                + "}"
                                + "};"
                                + "reader.readAsDataURL(b);"
                                + "}).catch(function(){});"
                                + "})("
                                + JSONObject.quote(url) + ","
                                + JSONObject.quote(fallbackName) + ","
                                + JSONObject.quote(mimeType != null ? mimeType : "application/octet-stream")
                                + ");";
                webView.evaluateJavascript(js, null);
                return;
            }

            try {
                String fileName = sanitizeFileName(URLUtil.guessFileName(url, contentDisposition, mimeType));
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isEmpty()) {
                    request.addRequestHeader("Cookie", cookies);
                }
                request.addRequestHeader("User-Agent", userAgent);
                request.setTitle(fileName);
                request.setDescription("Downloading LedgerFlow file...");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(request);
                    Toast.makeText(this, "Downloading " + fileName, Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                Toast.makeText(this, "Download failed.", Toast.LENGTH_SHORT).show();
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            }
        });

        requestInitialDevicePermissions();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(entryUrl);
        }
    }

    private boolean isPermissionGranted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestInitialDevicePermissions() {
        String[] desired = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.SEND_SMS,
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_SMS
        };
        List<String> missing = new ArrayList<>();
        for (String perm : desired) {
            if (!isPermissionGranted(perm)) {
                missing.add(perm);
            }
        }
        if (!missing.isEmpty()) {
            runtimePermissionsLauncher.launch(missing.toArray(new String[0]));
        }
    }

    private Intent createCameraCaptureIntent() {
        try {
            File cameraDir = new File(getCacheDir(), "camera");
            if (!cameraDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                cameraDir.mkdirs();
            }
            File photoFile = new File(cameraDir, "scan_" + System.currentTimeMillis() + ".jpg");
            Uri photoUri = FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    photoFile
            );
            pendingCameraCaptureUri = photoUri;
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            return intent;
        } catch (Exception e) {
            pendingCameraCaptureUri = null;
            return null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        emailExecutor.shutdownNow();
        super.onDestroy();
    }

    private String sanitizeFileName(String rawName) {
        String name = rawName == null ? "" : rawName.trim();
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_").replace("..", "_");
        if (name.isEmpty() || "downloadfile.bin".equalsIgnoreCase(name)) {
            name = "LedgerFlow-Export-" + System.currentTimeMillis() + ".pdf";
        }
        return name;
    }

    private String readStream(InputStream stream) {
        if (stream == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        } catch (Exception ignored) {
            // Return whatever was read
        }
        return sb.toString();
    }

    private void notifyEmailOtpResult(String requestId, boolean ok, String errorMessage) {
        runOnUiThread(() -> {
            if (webView == null) {
                return;
            }
            String js = "if(window.__lfOnOtpEmailResult){window.__lfOnOtpEmailResult("
                    + JSONObject.quote(requestId != null ? requestId : "") + ","
                    + (ok ? "true" : "false") + ","
                    + JSONObject.quote(errorMessage != null ? errorMessage : "")
                    + ");}";
            webView.evaluateJavascript(js, null);
        });
    }

    private class AndroidBridge {
        @JavascriptInterface
        public String getApiBaseUrl() {
            String raw = BuildConfig.API_BASE_URL != null ? BuildConfig.API_BASE_URL.trim() : "";
            while (raw.endsWith("/")) {
                raw = raw.substring(0, raw.length() - 1);
            }
            return raw;
        }

        @JavascriptInterface
        public boolean isOtpEmailConfigured() {
            String webhookUrl = BuildConfig.OTP_EMAIL_WEBHOOK_URL != null
                    ? BuildConfig.OTP_EMAIL_WEBHOOK_URL.trim()
                    : "";
            return webhookUrl.startsWith("https://");
        }

        @JavascriptInterface
        public boolean hasSmsPermission() {
            return isPermissionGranted(Manifest.permission.SEND_SMS);
        }

        @JavascriptInterface
        public void requestDevicePermissions() {
            runOnUiThread(MainActivity.this::requestInitialDevicePermissions);
        }

        @JavascriptInterface
        public boolean sendSmsOtp(String toMobile, String message) {
            if (!isPermissionGranted(Manifest.permission.SEND_SMS)) {
                runOnUiThread(() -> runtimePermissionsLauncher.launch(new String[]{
                        Manifest.permission.SEND_SMS,
                        Manifest.permission.RECEIVE_SMS,
                        Manifest.permission.READ_SMS
                }));
                return false;
            }
            String cleanNumber = toMobile == null ? "" : toMobile.trim().replaceAll("[^+0-9]", "");
            if (cleanNumber.length() < 10 || message == null || message.trim().isEmpty()) {
                return false;
            }
            try {
                SmsManager smsManager;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    smsManager = getSystemService(SmsManager.class);
                } else {
                    //noinspection deprecation
                    smsManager = SmsManager.getDefault();
                }
                if (smsManager == null) {
                    return false;
                }
                smsManager.sendTextMessage(cleanNumber, null, message.trim(), null, null);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void openSmsComposer(String toMobile, String message) {
            runOnUiThread(() -> {
                try {
                    String cleanNumber = toMobile == null ? "" : toMobile.trim();
                    Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + cleanNumber));
                    if (message != null && !message.isEmpty()) {
                        intent.putExtra("sms_body", message);
                    }
                    startActivity(intent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "No SMS app found on device.", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void sendOtpEmail(
                String requestId,
                String toEmail,
                String fullName,
                String loginIdentifier,
                String otp,
                String purpose
        ) {
            String webhookUrl = BuildConfig.OTP_EMAIL_WEBHOOK_URL != null
                    ? BuildConfig.OTP_EMAIL_WEBHOOK_URL.trim()
                    : "";
            if (!webhookUrl.startsWith("https://")) {
                notifyEmailOtpResult(
                        requestId,
                        false,
                        "Email OTP service is not configured yet. Add OTP_EMAIL_WEBHOOK_URL in GitHub Repository Secrets and rebuild the APK."
                );
                return;
            }

            emailExecutor.execute(() -> {
                HttpURLConnection conn = null;
                HttpURLConnection redirectConn = null;
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("to", toEmail != null ? toEmail.trim() : "");
                    payload.put("fullName", fullName != null ? fullName.trim() : "LedgerFlow User");
                    payload.put("loginIdentifier", loginIdentifier != null ? loginIdentifier.trim() : "");
                    payload.put("otp", otp != null ? otp.trim() : "");
                    payload.put("purpose", purpose != null ? purpose.trim() : "login");
                    if (BuildConfig.OTP_EMAIL_WEBHOOK_SECRET != null
                            && !BuildConfig.OTP_EMAIL_WEBHOOK_SECRET.trim().isEmpty()) {
                        payload.put("secret", BuildConfig.OTP_EMAIL_WEBHOOK_SECRET.trim());
                    }

                    byte[] bodyBytes = payload.toString().getBytes(StandardCharsets.UTF_8);

                    conn = (HttpURLConnection) new URL(webhookUrl).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(15000);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                    conn.setRequestProperty("Accept", "application/json");
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(bodyBytes);
                        os.flush();
                    }

                    int code = conn.getResponseCode();
                    String responseBody;

                    // Google Apps Script Web Apps execute doPost() and return 302 -> GET echo URL
                    if (code == HttpURLConnection.HTTP_MOVED_TEMP
                            || code == HttpURLConnection.HTTP_MOVED_PERM
                            || code == HttpURLConnection.HTTP_SEE_OTHER
                            || code == 307
                            || code == 308) {
                        String location = conn.getHeaderField("Location");
                        if (location != null && !location.trim().isEmpty()) {
                            redirectConn = (HttpURLConnection) new URL(location).openConnection();
                            redirectConn.setRequestMethod("GET");
                            redirectConn.setInstanceFollowRedirects(true);
                            redirectConn.setConnectTimeout(15000);
                            redirectConn.setReadTimeout(15000);
                            redirectConn.setRequestProperty("Accept", "application/json");
                            code = redirectConn.getResponseCode();
                            responseBody = readStream(
                                    code >= 400 ? redirectConn.getErrorStream() : redirectConn.getInputStream()
                            );
                        } else {
                            responseBody = "";
                        }
                    } else {
                        responseBody = readStream(
                                code >= 400 ? conn.getErrorStream() : conn.getInputStream()
                        );
                    }

                    if (code < 200 || code >= 300) {
                        notifyEmailOtpResult(
                                requestId,
                                false,
                                "Email OTP service returned HTTP " + code + ". Please check your Apps Script deployment."
                        );
                        return;
                    }

                    if (!responseBody.trim().isEmpty() && responseBody.trim().startsWith("{")) {
                        JSONObject resJson = new JSONObject(responseBody);
                        if (resJson.has("ok") && !resJson.optBoolean("ok", true)) {
                            String errMsg = resJson.optString("error", "Email OTP delivery failed.");
                            notifyEmailOtpResult(requestId, false, errMsg);
                            return;
                        }
                    }

                    notifyEmailOtpResult(requestId, true, "");
                } catch (Exception e) {
                    notifyEmailOtpResult(
                            requestId,
                            false,
                            "Unable to send OTP email. Please check internet connectivity and try again."
                    );
                } finally {
                    if (redirectConn != null) {
                        redirectConn.disconnect();
                    }
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            });
        }

        @JavascriptInterface
        public void saveBase64File(String dataUrl, String suggestedName, String mimeType) {
            if (dataUrl == null || dataUrl.isEmpty()) {
                return;
            }
            String safeName = sanitizeFileName(suggestedName);
            String safeMime = (mimeType != null && !mimeType.isEmpty())
                    ? mimeType
                    : "application/octet-stream";

            try {
                int commaIdx = dataUrl.indexOf(',');
                String base64Payload = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
                byte[] bytes = Base64.decode(base64Payload, Base64.DEFAULT);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) {
                        throw new IllegalStateException("Could not create download entry.");
                    }
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) {
                            throw new IllegalStateException("Could not open output stream.");
                        }
                        out.write(bytes);
                        out.flush();
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadsDir.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        downloadsDir.mkdirs();
                    }
                    File outFile = new File(downloadsDir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                        fos.flush();
                    }
                }

                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this,
                        "Saved to Downloads: " + safeName,
                        Toast.LENGTH_LONG
                ).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this,
                        "Unable to save file: " + safeName,
                        Toast.LENGTH_LONG
                ).show());
            }
        }
    }
}
