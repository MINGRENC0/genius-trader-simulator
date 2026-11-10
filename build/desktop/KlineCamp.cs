using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace KlineCamp
{
    /// <summary>
    /// 天才交易员模拟器 桌面版：内置页面与行情数据，启动本机静态服务后
    /// 用 Edge/Chrome 的“应用窗口”模式打开，表现为独立软件。
    /// </summary>
    static class Program
    {
        static Dictionary<string, byte[]> assets = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        static Dictionary<string, string> assetNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        static Assembly assetAsm;
        static TcpListener listener;
        static string baseDir;

        [STAThread]
        static void Main(string[] args)
        {
            string portFile = null;
            bool serveOnly = false;
            foreach (string a in args)
            {
                if (a.StartsWith("--serve-only", StringComparison.OrdinalIgnoreCase))
                {
                    serveOnly = true;
                    int eq = a.IndexOf('=');
                    if (eq > 0) portFile = a.Substring(eq + 1);
                }
            }

            baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KlineCamp");

            try
            {
                LoadAssets();
                int port = StartServer();
                if (portFile != null) File.WriteAllText(portFile, port.ToString());
                if (serveOnly)
                {
                    Thread.Sleep(Timeout.Infinite);
                    return;
                }

                string url = "http://127.0.0.1:" + port + "/app/kline-training.html?app=1";

                bool first;
                using (Mutex only = new Mutex(true, "KlineCampSingleInstance", out first))
                {
                    if (!first)
                    {
                        // 已有实例在运行：直接开窗口指向它
                        string running = ReadUrl();
                        LaunchBrowser(running != null ? running : url, false);
                        return;
                    }

                    WriteUrl(url);
                    LaunchBrowser(url, true);
                    DeleteUrl();
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动失败：" + ex.Message, "天才交易员模拟器",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (listener != null)
                {
                    try { listener.Stop(); } catch { }
                }
            }
        }

        static string UrlPath
        {
            get { return Path.Combine(baseDir, "url.txt"); }
        }

        static void WriteUrl(string url)
        {
            try
            {
                Directory.CreateDirectory(baseDir);
                File.WriteAllText(UrlPath, url, Encoding.UTF8);
            }
            catch { }
        }

        static string ReadUrl()
        {
            try
            {
                if (File.Exists(UrlPath)) return File.ReadAllText(UrlPath, Encoding.UTF8).Trim();
            }
            catch { }
            return null;
        }

        static void DeleteUrl()
        {
            try { if (File.Exists(UrlPath)) File.Delete(UrlPath); } catch { }
        }

        /// <summary>登记打包进 exe 的资源；行情分片按需读取，避免启动时常驻数百 MB 内存。</summary>
        static void LoadAssets()
        {
            assetAsm = Assembly.GetExecutingAssembly();
            foreach (string name in assetAsm.GetManifestResourceNames())
            {
                assetNames[name.Replace('\\', '/')] = name;
            }
            if (!assetNames.ContainsKey("app/kline-training.html"))
                throw new Exception("程序内部缺少页面资源，请重新生成 exe。");
        }

        static byte[] GetAsset(string rel)
        {
            byte[] hit;
            if (assets.TryGetValue(rel, out hit)) return hit;
            string name;
            if (!assetNames.TryGetValue(rel, out name)) return null;
            using (Stream s = assetAsm.GetManifestResourceStream(name))
            {
                if (s == null) return null;
                using (MemoryStream ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    hit = ms.ToArray();
                }
            }
            bool largePack = rel.StartsWith("data/kline-pack-", StringComparison.OrdinalIgnoreCase)
                || rel.StartsWith("data/kline-news-pack-", StringComparison.OrdinalIgnoreCase);
            if (!largePack)
                assets[rel] = hit;
            return hit;
        }

        static int StartServer()
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Thread t = new Thread(delegate ()
            {
                while (true)
                {
                    TcpClient client;
                    try { client = listener.AcceptTcpClient(); }
                    catch { return; }
                    ThreadPool.QueueUserWorkItem(delegate (object state)
                    {
                        TcpClient c = (TcpClient)state;
                        try { Serve(c); }
                        catch { }
                        finally { try { c.Close(); } catch { } }
                    }, client);
                }
            });
            t.IsBackground = true;
            t.Start();
            return port;
        }

        static void Serve(TcpClient c)
        {
            c.ReceiveTimeout = 30000;
            using (NetworkStream ns = c.GetStream())
            {
                StreamReader reader = new StreamReader(ns, Encoding.GetEncoding("iso-8859-1"));
                string first = reader.ReadLine();
                string line;
                while ((line = reader.ReadLine()) != null && line.Length > 0) { }
                if (string.IsNullOrEmpty(first)) return;

                string[] parts = first.Split(' ');
                if (parts.Length < 2) return;

                string path = parts[1];
                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);
                try { path = Uri.UnescapeDataString(path); } catch { }
                if (path.Length == 0 || path == "/") path = "/app/kline-training.html";

                string rel = path.TrimStart('/').Replace('\\', '/');
                byte[] body = GetAsset(rel);
                if (body == null)
                {
                    byte[] nf = Encoding.UTF8.GetBytes("Not Found");
                    byte[] head0 = Encoding.ASCII.GetBytes(
                        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\n" +
                        "Content-Length: " + nf.Length + "\r\nConnection: close\r\n\r\n");
                    ns.Write(head0, 0, head0.Length);
                    ns.Write(nf, 0, nf.Length);
                    return;
                }

                byte[] head = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 200 OK\r\nContent-Type: " + Mime(rel) + "\r\n" +
                    "Content-Length: " + body.Length + "\r\n" +
                    "Cache-Control: no-cache\r\nConnection: close\r\n\r\n");
                ns.Write(head, 0, head.Length);
                ns.Write(body, 0, body.Length);
                ns.Flush();
            }
        }

        static string Mime(string p)
        {
            string s = p.ToLowerInvariant();
            if (s.EndsWith(".html")) return "text/html; charset=utf-8";
            if (s.EndsWith(".js")) return "application/javascript; charset=utf-8";
            if (s.EndsWith(".css")) return "text/css; charset=utf-8";
            if (s.EndsWith(".webmanifest") || s.EndsWith(".json")) return "application/manifest+json; charset=utf-8";
            if (s.EndsWith(".png")) return "image/png";
            if (s.EndsWith(".svg")) return "image/svg+xml";
            if (s.EndsWith(".ico")) return "image/x-icon";
            return "application/octet-stream";
        }

        static void LaunchBrowser(string url, bool wait)
        {
            string exe = FindBrowser();
            if (exe == null)
            {
                MessageBox.Show("未找到 Microsoft Edge 或 Chrome，将用默认浏览器打开网页版。",
                    "天才交易员模拟器", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return;
            }

            string profile = Path.Combine(baseDir, "browser");
            string portFile = Path.Combine(profile, "DevToolsActivePort");
            try { if (File.Exists(portFile)) File.Delete(portFile); } catch { }

            string args = "--app=\"" + url + "\""
                        + " --user-data-dir=\"" + profile + "\""
                        + " --remote-debugging-port=0"
                        + " --window-size=1320,900"
                        + " --no-first-run --no-default-browser-check"
                        + " --disable-session-crashed-bubble --disable-features=Translate";

            ProcessStartInfo psi = new ProcessStartInfo(exe, args);
            psi.UseShellExecute = false;
            Process p = Process.Start(psi);
            if (!wait) return;

            // Edge 会把启动进程转交给真正的浏览器进程后自行退出，
            // 因此改用调试端口判断“应用窗口”是否还开着。
            int debugPort = WaitDevToolsPort(portFile, 15000);
            if (debugPort > 0)
            {
                while (DevToolsAlive(debugPort)) Thread.Sleep(1200);
            }
            else if (p != null)
            {
                p.WaitForExit();
                Thread.Sleep(2500);
            }
        }

        static int WaitDevToolsPort(string file, int timeoutMs)
        {
            int spent = 0;
            while (spent < timeoutMs)
            {
                try
                {
                    if (File.Exists(file))
                    {
                        string first = File.ReadAllLines(file)[0].Trim();
                        int port;
                        if (int.TryParse(first, out port) && port > 0) return port;
                    }
                }
                catch { }
                Thread.Sleep(300);
                spent += 300;
            }
            return 0;
        }

        static bool DevToolsAlive(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/json/version");
                req.Proxy = null;
                req.Timeout = 900;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        static string FindBrowser()
        {
            string[] keys = {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
            };
            foreach (string key in keys)
            {
                foreach (RegistryKey root in new RegistryKey[] { Registry.LocalMachine, Registry.CurrentUser })
                {
                    try
                    {
                        using (RegistryKey k = root.OpenSubKey(key))
                        {
                            if (k == null) continue;
                            string v = k.GetValue(null) as string;
                            if (!string.IsNullOrEmpty(v) && File.Exists(v)) return v;
                        }
                    }
                    catch { }
                }
            }

            string[] paths = {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
            };
            foreach (string p in paths)
            {
                if (File.Exists(p)) return p;
            }
            return null;
        }
    }
}
