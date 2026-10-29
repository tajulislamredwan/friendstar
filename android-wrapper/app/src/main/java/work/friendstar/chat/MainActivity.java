package work.friendstar.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ConsoleMessage;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final String HOME = "https://chat.friendstar.workers.dev/";
    private static final String TRUSTED_HOST = "chat.friendstar.workers.dev";
    private static final String TAG = "FriendStarAndroid";
    private static final int REQUEST_MEDIA_PERMISSIONS = 7201;
    private static final int REQUEST_FILE = 7202;

    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingWebPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(91, 75, 219));
        getWindow().setNavigationBarColor(Color.rgb(36, 30, 69));

        FrameLayout container = new FrameLayout(this);
        webView = new WebView(this);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.content.pm.PackageInfo webViewPackage = WebView.getCurrentWebViewPackage();
            Log.i(TAG, "System WebView: " + (webViewPackage == null ? "unknown" : webViewPackage.packageName + " " + webViewPackage.versionName));
        }
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(109, 93, 246)));
        progress.setBackgroundColor(Color.TRANSPARENT);
        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        container.addView(progress, progressParams);
        setContentView(container);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);

        webView.setBackgroundColor(Color.WHITE);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return routeUrl(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           android.net.http.SslError error) {
                handler.cancel();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Log.e(TAG, "Main page load failed: " + request.getUrl() + " error=" + error.getErrorCode());
                }
                super.onReceivedError(view, request, error);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith(HOME)) {
                    view.evaluateJavascript("JSON.stringify({secure:window.isSecureContext,media:!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia),rtc:typeof RTCPeerConnection==='function'})", value -> Log.i(TAG, "Call capability check: " + value));
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                Log.i(TAG, "Web media permission request: origin=" + request.getOrigin() + " resources=" + java.util.Arrays.toString(request.getResources()));
                runOnUiThread(() -> requestMediaPermission(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                Log.i(TAG, "Web media permission request canceled");
                if (pendingWebPermission == request) pendingWebPermission = null;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                String line = message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")";
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e(TAG, line);
                else Log.d(TAG, line);
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a file"), REQUEST_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "No file picker is available.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            // FriendStar files are signed HTTPS URLs on this same host; never hand off arbitrary schemes.
            Uri download = Uri.parse(url);
            if (!"https".equalsIgnoreCase(download.getScheme())
                    || !TRUSTED_HOST.equalsIgnoreCase(download.getHost())) {
                Toast.makeText(this, "This download link is not trusted.", Toast.LENGTH_SHORT).show();
                return;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, download));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(this, "No app can open this download.", Toast.LENGTH_SHORT).show();
            }
        });
        webView.loadUrl(HOME);
    }

    private boolean routeUrl(Uri uri) {
        if (uri == null) return true;
        if ("https".equalsIgnoreCase(uri.getScheme()) && TRUSTED_HOST.equalsIgnoreCase(uri.getHost())) {
            return false;
        }
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                Toast.makeText(this, "No browser is available for this link.", Toast.LENGTH_SHORT).show();
            }
        }
        return true;
    }

    private void requestMediaPermission(PermissionRequest request) {
        if (!isTrustedOrigin(request.getOrigin())) {
            request.deny();
            return;
        }
        pendingWebPermission = request;
        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.RECORD_AUDIO);
            }
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.CAMERA);
            }
        }
        if (needed.isEmpty()) {
            grantWebResources(request);
        } else {
            requestPermissions(needed.toArray(new String[0]), REQUEST_MEDIA_PERMISSIONS);
        }
    }

    private boolean isTrustedOrigin(Uri origin) {
        return origin != null && "https".equalsIgnoreCase(origin.getScheme())
                && TRUSTED_HOST.equalsIgnoreCase(origin.getHost());
    }

    private void grantWebResources(PermissionRequest request) {
        if (request != pendingWebPermission) return;
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                allowed.add(resource);
            }
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                allowed.add(resource);
            }
        }
        pendingWebPermission = null;
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_MEDIA_PERMISSIONS && pendingWebPermission != null) {
            PermissionRequest request = pendingWebPermission;
            boolean granted = true;
            for (int result : results) granted &= result == PackageManager.PERMISSION_GRANTED;
            if (granted) grantWebResources(request);
            else {
                pendingWebPermission = null;
                request.deny();
                Toast.makeText(this, "Allow FriendStar microphone/camera in Android Settings to make calls.", Toast.LENGTH_LONG).show();
                Log.w(TAG, "Android media permission denied; call access was denied");
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
