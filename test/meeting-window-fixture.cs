// A local Windows accessibility fixture. It opens no microphone, network or conferencing account.
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class TestCallWindow {
  [STAThread]
  static void Main(string[] args) {
    var window = new Form { Text = "Desktop voice call fixture", ShowInTaskbar = false,
      StartPosition = FormStartPosition.Manual, Location = new Point(-12000, 40), Size = new Size(360, 180) };
    var mic = new Button { Text = "Unmute my microphone", Width = 140 };
    var leave = new Button { Text = "Leave call", Left = 150, Width = 120 };
    window.Controls.Add(mic);
    window.Controls.Add(leave);
    var tick = new Timer { Interval = 50 };
    tick.Tick += delegate {
      string state;
      try { state = File.ReadAllText(args[0]); } catch (IOException) { return; }
      if (state == "exit") { window.Close(); return; }
      mic.Text = state == "open" ? "Mute my microphone" : "Unmute my microphone";
      mic.Visible = state != "ended";
      leave.Text = state == "ended" ? "Call again" : "Leave call";
    };
    window.Shown += delegate { tick.Start(); };
    Application.Run(window);
  }
}
