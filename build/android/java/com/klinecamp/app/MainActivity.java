package com.klinecamp.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;

/**
 * 应用入口：把打包进 assets 的 K 线训练营页面用 WebView 打开。
 * 页面通过本机 127.0.0.1 上的微型 HTTP 服务加载，
 * 以获得正常的来源（localStorage 可用、相对路径正常）。
 */
public class MainActivity extends Activity {

    private WebView web;
    private AssetServer server;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#070a10"));
        getWindow().setNavigationBarColor(Color.parseColor("#070a10"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#070a10"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "KlineApp");

        setContentView(web);

        try {
            server = new AssetServer(getAssets());
            int port = server.start();
            web.loadUrl("http://127.0.0.1:" + port + "/app/kline-mobile.html");
        } catch (IOException e) {
            web.loadData("<div style=\"padding:32px;color:#e7eef8;background:#070a10;"
                    + "font-family:sans-serif;line-height:2\">本地资源启动失败：" + e.getMessage() + "</div>",
                    "text/html", "utf-8");
        }
    }

    /** 供网页检测运行环境。 */
    public class Bridge {
        @JavascriptInterface
        public String isApp() {
            return "1";
        }

        @JavascriptInterface
        public String version() {
            return "1.9.0";
        }

        /** 用系统浏览器打开外部链接，避免把 WebView 导航出应用。 */
        @JavascriptInterface
        public void openUrl(String url) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception ignored) {
            }
        }
    }

    /** 返回键交给网页处理（关弹窗/抽屉/回首页），未处理才退出 App。 */
    private void handleBack() {
        web.evaluateJavascript("(window.KlineBack && window.KlineBack()) ? '1' : '0'", value -> {
            if (!"\"1\"".equals(value)) {
                finish();
            }
        });
    }

    @Override
    public void onBackPressed() {
        // 全面屏手势 / 系统返回（Android 13+ 走这里，不一定是按键事件）
        handleBack();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** 只监听 127.0.0.1 的静态资源服务，数据来自 APK 内的 assets。 */
    static class AssetServer {

        private final android.content.res.AssetManager am;
        private ServerSocket serverSocket;

        AssetServer(android.content.res.AssetManager am) {
            this.am = am;
        }

        /** 固定端口：localStorage 按来源（含端口）隔离，端口每次都变会导致存档全部丢失。 */
        private static final int[] PORTS = {18760, 18761, 18762};

        int start() throws IOException {
            for (int port : PORTS) {
                try {
                    serverSocket = new ServerSocket();
                    serverSocket.setReuseAddress(true);
                    serverSocket.bind(new java.net.InetSocketAddress(
                            InetAddress.getByAddress(new byte[]{127, 0, 0, 1}), port));
                    return listen();
                } catch (IOException e) {
                    closeSocket();
                }
            }
            // 兜底：固定端口都被占用时才用随机端口
            serverSocket = new ServerSocket(0, 16, InetAddress.getByAddress(new byte[]{127, 0, 0, 1}));
            return listen();
        }

        private int listen() {
            final ServerSocket ss = serverSocket;
            Thread t = new Thread(() -> {
                while (true) {
                    try {
                        final Socket c = ss.accept();
                        Thread w = new Thread(() -> serve(c));
                        w.setDaemon(true);
                        w.start();
                    } catch (IOException e) {
                        return;
                    }
                }
            });
            t.setDaemon(true);
            t.start();
            return ss.getLocalPort();
        }

        void stop() {
            closeSocket();
        }

        private void closeSocket() {
            try {
                if (serverSocket != null) serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }

        private void serve(Socket c) {
            InputStream in = null;
            try {
                c.setSoTimeout(30000);
                java.io.BufferedReader reader =
                        new java.io.BufferedReader(new java.io.InputStreamReader(c.getInputStream(), "ISO-8859-1"));
                String first = reader.readLine();
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    // 读掉请求头
                }
                if (first == null) return;

                String[] parts = first.split(" ");
                if (parts.length < 2) return;

                String path = parts[1];
                int q = path.indexOf('?');
                if (q >= 0) path = path.substring(0, q);
                try {
                    path = URLDecoder.decode(path, "UTF-8");
                } catch (Exception ignored) {
                }
                if (path.isEmpty() || path.equals("/")) path = "/app/kline-mobile.html";
                String asset = path.startsWith("/") ? path.substring(1) : path;

                OutputStream out = new BufferedOutputStream(c.getOutputStream(), 65536);
                try {
                    in = am.open(asset);
                } catch (IOException e) {
                    in = null;
                }
                if (in == null) {
                    byte[] body = "Not Found".getBytes("UTF-8");
                    out.write(("HTTP/1.1 404 Not Found\r\n"
                            + "Content-Type: text/plain; charset=utf-8\r\n"
                            + "Content-Length: " + body.length + "\r\n"
                            + "Connection: close\r\n\r\n").getBytes("ISO-8859-1"));
                    out.write(body);
                    out.flush();
                    return;
                }

                out.write(("HTTP/1.1 200 OK\r\n"
                        + "Content-Type: " + mime(asset) + "\r\n"
                        + "Cache-Control: no-cache\r\n"
                        + "Transfer-Encoding: chunked\r\n"
                        + "Connection: close\r\n\r\n").getBytes("ISO-8859-1"));

                BufferedInputStream bin = new BufferedInputStream(in, 65536);
                byte[] buf = new byte[65536];
                int n;
                while ((n = bin.read(buf)) > 0) {
                    out.write((Integer.toHexString(n) + "\r\n").getBytes("ISO-8859-1"));
                    out.write(buf, 0, n);
                    out.write("\r\n".getBytes("ISO-8859-1"));
                }
                bin.close();
                out.write("0\r\n\r\n".getBytes("ISO-8859-1"));
                out.flush();
            } catch (IOException ignored) {
            } finally {
                try {
                    c.close();
                } catch (IOException ignored) {
                }
            }
        }

        private static String mime(String p) {
            String s = p.toLowerCase();
            if (s.endsWith(".html")) return "text/html; charset=utf-8";
            if (s.endsWith(".js")) return "application/javascript; charset=utf-8";
            if (s.endsWith(".css")) return "text/css; charset=utf-8";
            if (s.endsWith(".webmanifest") || s.endsWith(".json")) return "application/manifest+json; charset=utf-8";
            if (s.endsWith(".png")) return "image/png";
            if (s.endsWith(".svg")) return "image/svg+xml";
            if (s.endsWith(".ico")) return "image/x-icon";
            return "application/octet-stream";
        }
    }
}
