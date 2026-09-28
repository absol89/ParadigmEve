using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

// Owned, disposable target for the background WGC test. It deliberately never activates:
// the production contract being tested is that named-window observation does not need focus.
public static class BackgroundCaptureFixture {
  [DllImport("dwmapi.dll")] static extern int DwmFlush();

  [STAThread] public static void Main() {
    var app = new Application();
    var window = new Window {
      Title = "ParadigmEve owned background capture fixture",
      Left = 140,
      Top = 140,
      Width = 420,
      Height = 280,
      Background = Brushes.LimeGreen,
      ShowActivated = false,
      ShowInTaskbar = false
    };
    window.SourceInitialized += delegate {
      DwmFlush();
      var ready = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
      ready.Tick += delegate {
        ready.Stop();
        Console.WriteLine(new WindowInteropHelper(window).Handle.ToInt64());
        Console.Out.Flush();
      };
      ready.Start();
      var reader = new Thread(delegate() {
        if (Console.ReadLine() != null) {
          window.Dispatcher.Invoke(new Action(delegate { window.Close(); }));
        }
      });
      reader.IsBackground = true;
      reader.Start();
    };
    app.Run(window);
  }
}
