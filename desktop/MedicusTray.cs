// Medicus Vitae tray launcher for Windows. Compiled by desktop/build.ps1 with the
// C# compiler built into Windows (.NET Framework 4), so it is C# 5.
// Starts `node server/index.js` hidden, shows a tray icon, opens the browser,
// and stops the server cleanly on Quit. Closing this app closes the server's
// stdin, which the server treats as "stop" (CORTEX_WATCH_STDIN=1).

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class MedicusTray
{
    const string Name = "Medicus Vitae";
    static string appDir;
    static string url;
    static string healthUrl;
    static Process server;
    static NotifyIcon tray;
    static StreamWriter log;
    static bool quitting;
    static bool openBrowser = true;
    static SynchronizationContext ui;

    [STAThread]
    static void Main(string[] args)
    {
        appDir = Path.GetDirectoryName(Application.ExecutablePath);
        foreach (string a in args) if (a == "--no-browser") openBrowser = false;
        int port = ReadPort();
        url = "http://localhost:" + port + "/";
        // The server listens on IPv4; "localhost" can resolve to IPv6 first on Windows.
        string host = ReadSetting("HOST", "127.0.0.1");
        healthUrl = "http://" + (host == "0.0.0.0" || host == "localhost" || host == "" ? "127.0.0.1" : host) + ":" + port + "/api/health";

        // The mutex keeps its old name, so this app and the earlier Cortex.exe never both start a server.
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\CortexTray-" + appDir.ToLowerInvariant().GetHashCode().ToString("x"), out created))
        {
            if (!created)
            {
                OpenBrowser();
                return;
            }
            if (IsHealthy())
            {
                // Started some other way (npm start): just open it.
                OpenBrowser();
                return;
            }
            MoveOldStartupShortcut();
            Application.EnableVisualStyles();
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            BuildTray();
            StartServer();
            Application.Run();
        }
    }

    /** A value from the .env file next to the app, or the fallback. */
    static string ReadSetting(string name, string fallback)
    {
        string env = Path.Combine(appDir, ".env");
        if (!File.Exists(env)) return fallback;
        foreach (string raw in File.ReadAllLines(env))
        {
            string line = raw.Trim();
            if (line.StartsWith(name + "="))
            {
                string v = line.Substring(name.Length + 1).Trim().Trim('"');
                if (v.Length > 0) return v;
            }
        }
        return fallback;
    }

    static int ReadPort()
    {
        int p;
        return int.TryParse(ReadSetting("PORT", "8080"), out p) ? p : 8080;
    }

    static string DataDir()
    {
        return Path.GetFullPath(Path.Combine(appDir, ReadSetting("CORTEX_DATA_DIR", "data")));
    }

    /** The mark: a teal rounded square with a white "M" (the same shape as static/favicon.svg). */
    static Icon MakeIcon(int size)
    {
        Bitmap bmp = new Bitmap(size, size);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            float r = size * 0.25f;
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddArc(0, 0, r * 2, r * 2, 180, 90);
                path.AddArc(size - r * 2 - 1, 0, r * 2, r * 2, 270, 90);
                path.AddArc(size - r * 2 - 1, size - r * 2 - 1, r * 2, r * 2, 0, 90);
                path.AddArc(0, size - r * 2 - 1, r * 2, r * 2, 90, 90);
                path.CloseFigure();
                using (SolidBrush teal = new SolidBrush(Color.FromArgb(15, 118, 110))) g.FillPath(teal, path);
            }
            float[,] m = { { 17, 46 }, { 17, 19 }, { 22.5f, 19 }, { 32, 34 }, { 41.5f, 19 }, { 47, 19 }, { 47, 46 }, { 41, 46 }, { 41, 30.5f }, { 33.6f, 42 }, { 30.4f, 42 }, { 23, 30.5f }, { 23, 46 } };
            PointF[] points = new PointF[m.GetLength(0)];
            float k = size / 64f;
            for (int i = 0; i < points.Length; i++) points[i] = new PointF(m[i, 0] * k, m[i, 1] * k);
            using (SolidBrush white = new SolidBrush(Color.White)) g.FillPolygon(white, points);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    static void BuildTray()
    {
        tray = new NotifyIcon();
        tray.Icon = MakeIcon(Math.Max(16, SystemInformation.SmallIconSize.Width));
        tray.Text = Name + " (starting)";
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open " + Name, null, delegate { OpenBrowser(); });
        menu.Items.Add("Open data folder", null, delegate { Shell(DataDir()); });
        menu.Items.Add("Open server log", null, delegate { Shell(LogPath()); });
        menu.Items.Add(new ToolStripSeparator());
        ToolStripMenuItem startup = new ToolStripMenuItem("Start with Windows");
        startup.Checked = File.Exists(StartupShortcut());
        startup.Click += delegate { ToggleStartup(startup); };
        menu.Items.Add(startup);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart server", null, delegate { Restart(); });
        menu.Items.Add("Quit Medicus", null, delegate { Quit(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenBrowser(); };
        tray.Visible = true;
        Microsoft.Win32.SystemEvents.SessionEnding += delegate { Quit(); };
    }

    static string LogPath()
    {
        return Path.Combine(DataDir(), "logs", "server.log");
    }

    static void StartServer()
    {
        string node = Path.Combine(appDir, "runtime", "node", "node.exe");
        if (!File.Exists(node)) node = "node";
        Directory.CreateDirectory(Path.GetDirectoryName(LogPath()));
        try
        {
            if (File.Exists(LogPath()) && new FileInfo(LogPath()).Length > 5 * 1024 * 1024)
                File.Copy(LogPath(), LogPath() + ".old", true);
            bool append = File.Exists(LogPath()) && new FileInfo(LogPath()).Length <= 5 * 1024 * 1024;
            log = new StreamWriter(LogPath(), append);
            log.AutoFlush = true;
        }
        catch { log = null; }

        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + Path.Combine(appDir, "server", "index.js") + "\"");
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = System.Text.Encoding.UTF8;
        psi.StandardErrorEncoding = System.Text.Encoding.UTF8;
        psi.EnvironmentVariables["CORTEX_WATCH_STDIN"] = "1";
        psi.EnvironmentVariables["CORTEX_LAUNCHER"] = "tray";
        server = new Process();
        server.StartInfo = psi;
        server.EnableRaisingEvents = true;
        server.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
        server.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
        server.Exited += delegate { ui.Post(delegate { OnServerExit(); }, null); };
        try
        {
            server.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not start " + Name + ":\n" + ex.Message, Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitTray();
            return;
        }
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        ThreadPool.QueueUserWorkItem(delegate
        {
            for (int i = 0; i < 120 && !quitting; i++)
            {
                if (server.HasExited) return;
                if (IsHealthy())
                {
                    ui.Post(delegate
                    {
                        tray.Text = Name + ": running at " + url;
                        if (openBrowser) OpenBrowser();
                        openBrowser = true;
                    }, null);
                    return;
                }
                Thread.Sleep(500);
            }
        });
    }

    static void WriteLog(string line)
    {
        if (line == null || log == null) return;
        try { lock (log) log.WriteLine(line); } catch { }
    }

    static void OnServerExit()
    {
        int code = 0;
        try { code = server.ExitCode; } catch { }
        if (quitting) { ExitTray(); return; }
        if (code == 0) { ExitTray(); return; }   // Quit from the web page.
        string message = code == 3
            ? "The port " + Name + " uses is taken by another program. Set a different PORT in " + Path.Combine(appDir, ".env") + "."
            : code == 4
                ? Name + " is already running with this data folder."
                : Name + " stopped unexpectedly (code " + code + "). The server log has details.";
        DialogResult answer = MessageBox.Show(message + "\n\nStart it again?", Name, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (answer == DialogResult.Yes) { openBrowser = false; StartServer(); }
        else ExitTray();
    }

    static bool IsHealthy()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(healthUrl);
            req.Timeout = 1500;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static void StopServer()
    {
        if (server == null || server.HasExited) return;
        try { server.StandardInput.Close(); } catch { }
        if (!server.WaitForExit(10000))
        {
            try { server.Kill(); } catch { }
        }
    }

    static void Restart()
    {
        quitting = true;
        StopServer();
        quitting = false;
        openBrowser = false;
        tray.Text = Name + " (starting)";
        StartServer();
    }

    static void Quit()
    {
        if (quitting) return;
        quitting = true;
        tray.Text = Name + " (stopping)";
        StopServer();
        ExitTray();
    }

    static void ExitTray()
    {
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
        if (log != null) { try { log.Close(); } catch { } }
        Application.Exit();
    }

    static void OpenBrowser() { Shell(url); }

    static void Shell(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
    }

    static string StartupShortcut()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), Name + ".lnk");
    }

    /** "Start with Windows" from the Cortex days: point it at this app instead. */
    static void MoveOldStartupShortcut()
    {
        string old = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Cortex.lnk");
        if (!File.Exists(old)) return;
        try
        {
            File.Delete(old);
            if (!File.Exists(StartupShortcut())) WriteShortcut(StartupShortcut(), "--no-browser");
        }
        catch { }
    }

    static void WriteShortcut(string lnk, string arguments)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object sc = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        Type st = sc.GetType();
        st.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { Application.ExecutablePath });
        st.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { arguments });
        st.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { appDir });
        st.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, sc, null);
    }

    static void ToggleStartup(ToolStripMenuItem item)
    {
        string lnk = StartupShortcut();
        try
        {
            if (File.Exists(lnk)) { File.Delete(lnk); item.Checked = false; return; }
            WriteShortcut(lnk, "--no-browser");
            item.Checked = true;
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not change the startup setting:\n" + ex.Message, Name);
        }
    }
}
