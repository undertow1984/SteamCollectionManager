# SteamCollectionManager background gamepad shortcut watcher
# Emits TRIGGER when Right Stick is clicked (R3).
$ErrorActionPreference = 'Stop'
$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class ScmGamepadWatcher
{
    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    static extern int XInputGetState14(int userIndex, ref XINPUT_STATE state);
    [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")]
    static extern int XInputGetState910(int userIndex, ref XINPUT_STATE state);

    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_GAMEPAD
    {
        public ushort wButtons;
        public byte bLeftTrigger;
        public byte bRightTrigger;
        public short sThumbLX;
        public short sThumbLY;
        public short sThumbRX;
        public short sThumbRY;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_STATE
    {
        public uint dwPacketNumber;
        public XINPUT_GAMEPAD Gamepad;
    }

    // Right stick click (R3)
    const ushort XINPUT_GAMEPAD_RIGHT_THUMB = 0x0080;
    static bool useLegacy = false;

    static int GetState(int i, ref XINPUT_STATE st)
    {
        try
        {
            return useLegacy ? XInputGetState910(i, ref st) : XInputGetState14(i, ref st);
        }
        catch
        {
            useLegacy = true;
            try { return XInputGetState910(i, ref st); } catch { return -1; }
        }
    }

    public static void Run()
    {
        Console.WriteLine("READY");
        Console.Out.Flush();
        XINPUT_STATE state = new XINPUT_STATE();
        bool wasPressed = false;
        while (true)
        {
            bool active = false;
            for (int i = 0; i < 4; i++)
            {
                if (GetState(i, ref state) != 0) continue;
                if ((state.Gamepad.wButtons & XINPUT_GAMEPAD_RIGHT_THUMB) != 0)
                {
                    active = true;
                    break;
                }
            }
            if (active)
            {
                if (!wasPressed)
                {
                    Console.WriteLine("TRIGGER");
                    Console.Out.Flush();
                    wasPressed = true;
                }
            }
            else
            {
                wasPressed = false;
            }
            Thread.Sleep(40);
        }
    }
}
'@
try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  # Type may already exist in this process — ignore "already exists" errors
  if ($_.Exception.Message -notmatch 'already exists') { throw }
}
[ScmGamepadWatcher]::Run()
