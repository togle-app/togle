// A console input fixture, not a shell: text is recorded and can never execute as a command.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
class DictationConsole {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AllocConsole();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool SetConsoleTitle(string title);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool ReadConsole(IntPtr handle, [Out] char[] buffer, uint count, out uint read, IntPtr reserved);
  static void Main(string[] args) {
    FreeConsole(); AllocConsole();
    SetConsoleTitle(args[1]);
    var input = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    SetConsoleMode(input, 0);
    File.WriteAllText(args[0] + ".window", GetConsoleWindow().ToInt64().ToString());
    var text = new StringBuilder();
    while (true) {
      var buffer = new char[1]; uint read;
      if (!ReadConsole(input, buffer, 1, out read, IntPtr.Zero)) return;
      if (read == 0) continue;
      text.Append(buffer[0]);
      File.WriteAllText(args[0] + ".text", text.ToString(), new UTF8Encoding(false));
    }
  }
}
