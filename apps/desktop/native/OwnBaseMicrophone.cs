// OwnBase's microphone helper for Windows.
//
// Chromium opens any microphone that supports it in raw mode, which skips the
// sound effects set up in Windows (Equalizer APO, a maker's noise removal):
// those run as stream effects, and Windows leaves stream effects out of raw
// streams. Other apps open microphones the ordinary way and hear them. This
// opens one the ordinary way too, a shared WASAPI stream in the default mode,
// so OwnBase hears what other apps hear.
//
//   ownbase-microphone list
//     Prints {"default": id or null, "microphones": [{"id", "name"}]} and exits.
//   ownbase-microphone capture <id | default>
//     Writes the microphone to stdout as mono 32-bit float samples, at the
//     rate Windows mixes it at, until stdin closes. Says what happens on
//     stderr, one JSON object a line: {"event":"started","sampleRate",
//     "channels","name"}, then {"event":"ended","reason"} if the device goes,
//     or {"event":"error","message"} if it cannot start.
//
// Built with the C# compiler that comes with Windows' .NET Framework 4 (see
// scripts/build-microphone.mjs), so C# 5: no string interpolation or `?.`.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace OwnBase
{
    static class Microphone
    {
        const int ExitStopped = 0;
        const int ExitFailed = 2;
        const int ExitEnded = 3;

        const uint DEVICE_STATE_ACTIVE = 1;
        const uint CLSCTX_ALL = 0x17;
        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const long BUFFER_100NS = 200000; // 20 ms
        const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
        const int E_NOTFOUND = unchecked((int)0x80070490);
        const ushort WAVE_FORMAT_PCM = 1;
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
        static readonly Guid SubtypePcm = new Guid("00000001-0000-0010-8000-00aa00389b71");
        static readonly Guid SubtypeFloat = new Guid("00000003-0000-0010-8000-00aa00389b71");

        static readonly object ErrLock = new object();
        /** Set once stdin closes, from the thread that watches it. */
        static volatile bool stopping;

        [MTAThread]
        static int Main(string[] args)
        {
            try
            {
                if (args.Length == 1 && args[0] == "list") return List();
                if (args.Length == 2 && args[0] == "capture") return Capture(args[1]);
                Event("error", "message", "usage: list | capture <id|default>");
                return ExitFailed;
            }
            catch (Exception e)
            {
                Event("error", "message", e.GetType().Name + ": " + e.Message);
                return ExitFailed;
            }
        }

        static IMMDeviceEnumerator Enumerator()
        {
            return (IMMDeviceEnumerator)new MMDeviceEnumerator();
        }

        static int List()
        {
            IMMDeviceEnumerator enumerator = Enumerator();
            string defaultId = null;
            IMMDevice fallback;
            if (enumerator.GetDefaultAudioEndpoint(EDataFlow.Capture, ERole.Console, out fallback) == 0)
                defaultId = IdOf(fallback);

            IMMDeviceCollection devices;
            Check(enumerator.EnumAudioEndpoints(EDataFlow.Capture, DEVICE_STATE_ACTIVE, out devices), "EnumAudioEndpoints");
            uint count;
            Check(devices.GetCount(out count), "GetCount");
            StringBuilder json = new StringBuilder();
            json.Append("{\"default\":").Append(defaultId == null ? "null" : Quote(defaultId)).Append(",\"microphones\":[");
            bool first = true;
            for (uint i = 0; i < count; i++)
            {
                IMMDevice device;
                if (devices.Item(i, out device) != 0) continue;
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"id\":").Append(Quote(IdOf(device)))
                    .Append(",\"name\":").Append(Quote(NameOf(device))).Append('}');
            }
            json.Append("]}");
            Console.Out.Write(json.ToString());
            Console.Out.Flush();
            return ExitStopped;
        }

        static int Capture(string id)
        {
            IMMDeviceEnumerator enumerator = Enumerator();
            IMMDevice device;
            int hr = id == "default"
                ? enumerator.GetDefaultAudioEndpoint(EDataFlow.Capture, ERole.Console, out device)
                : enumerator.GetDevice(id, out device);
            if (hr != 0)
            {
                Event("error", "message", hr == E_NOTFOUND ? "not found" : "GetDevice 0x" + hr.ToString("X8"));
                return ExitFailed;
            }

            Guid clientId = typeof(IAudioClient).GUID;
            object activated;
            Check(device.Activate(ref clientId, CLSCTX_ALL, IntPtr.Zero, out activated), "Activate");
            IAudioClient client = (IAudioClient)activated;

            IntPtr format;
            Check(client.GetMixFormat(out format), "GetMixFormat");
            int channels, rate, bits;
            bool isFloat;
            try
            {
                ushort tag = (ushort)Marshal.ReadInt16(format, 0);
                channels = Marshal.ReadInt16(format, 2);
                rate = Marshal.ReadInt32(format, 4);
                bits = Marshal.ReadInt16(format, 14);
                if (tag == WAVE_FORMAT_EXTENSIBLE)
                {
                    byte[] sub = new byte[16];
                    Marshal.Copy(new IntPtr(format.ToInt64() + 24), sub, 0, 16);
                    Guid subtype = new Guid(sub);
                    isFloat = subtype == SubtypeFloat;
                    if (!isFloat && subtype != SubtypePcm) throw new NotSupportedException("format " + subtype);
                }
                else
                {
                    isFloat = tag == WAVE_FORMAT_IEEE_FLOAT;
                    if (!isFloat && tag != WAVE_FORMAT_PCM) throw new NotSupportedException("format tag " + tag);
                }
                if (isFloat ? bits != 32 : bits != 16 && bits != 32)
                    throw new NotSupportedException(bits + "-bit samples");
                // No client properties: the stream is "Other" in the default
                // mode, never raw, so every effect Windows has for it runs.
                Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    BUFFER_100NS, 0, format, IntPtr.Zero), "Initialize");
            }
            finally
            {
                Marshal.FreeCoTaskMem(format);
            }

            AutoResetEvent ready = new AutoResetEvent(false);
            Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
            Guid captureId = typeof(IAudioCaptureClient).GUID;
            object service;
            Check(client.GetService(ref captureId, out service), "GetService");
            IAudioCaptureClient capture = (IAudioCaptureClient)service;

            // Closing stdin, or the app that started this going, stops it.
            Thread watcher = new Thread(delegate ()
            {
                try
                {
                    Stream input = Console.OpenStandardInput();
                    byte[] scratch = new byte[64];
                    while (input.Read(scratch, 0, scratch.Length) > 0) { }
                }
                catch (IOException) { }
                stopping = true;
                ready.Set();
            });
            watcher.IsBackground = true;
            watcher.Start();

            Check(client.Start(), "Start");
            Event3("started", "sampleRate", rate, "channels", channels, "name", NameOf(device));

            Stream output = Console.OpenStandardOutput();
            float[] mono = new float[0];
            byte[] bytes = new byte[0];
            float[] floats = new float[0];
            short[] shorts = new short[0];
            int[] ints = new int[0];
            try
            {
                while (!stopping)
                {
                    ready.WaitOne(200);
                    while (!stopping)
                    {
                        uint packet;
                        hr = capture.GetNextPacketSize(out packet);
                        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) return Ended("device-removed");
                        Check(hr, "GetNextPacketSize");
                        if (packet == 0) break;

                        IntPtr data;
                        uint frames, flags;
                        ulong devicePosition, qpcPosition;
                        hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) return Ended("device-removed");
                        Check(hr, "GetBuffer");
                        int n = (int)frames;
                        int samples = n * channels;
                        if (mono.Length < n) { mono = new float[n]; bytes = new byte[n * 4]; }
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                        {
                            Array.Clear(mono, 0, n);
                        }
                        else if (isFloat)
                        {
                            if (floats.Length < samples) floats = new float[samples];
                            Marshal.Copy(data, floats, 0, samples);
                            Downmix(floats, channels, n, mono, 1f);
                        }
                        else if (bits == 16)
                        {
                            if (shorts.Length < samples) shorts = new short[samples];
                            Marshal.Copy(data, shorts, 0, samples);
                            if (floats.Length < samples) floats = new float[samples];
                            for (int i = 0; i < samples; i++) floats[i] = shorts[i];
                            Downmix(floats, channels, n, mono, 1f / 32768f);
                        }
                        else
                        {
                            if (ints.Length < samples) ints = new int[samples];
                            Marshal.Copy(data, ints, 0, samples);
                            if (floats.Length < samples) floats = new float[samples];
                            for (int i = 0; i < samples; i++) floats[i] = ints[i];
                            Downmix(floats, channels, n, mono, 1f / 2147483648f);
                        }
                        Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
                        Buffer.BlockCopy(mono, 0, bytes, 0, n * 4);
                        output.Write(bytes, 0, n * 4);
                        output.Flush();
                    }
                }
            }
            catch (IOException)
            {
                // stdout closed: whoever was listening has gone.
            }
            finally
            {
                client.Stop();
            }
            return ExitStopped;
        }

        /** The channels averaged into one, as a browser makes a mono track. */
        static void Downmix(float[] interleaved, int channels, int frames, float[] mono, float scale)
        {
            float each = scale / channels;
            for (int f = 0; f < frames; f++)
            {
                float sum = 0;
                int at = f * channels;
                for (int c = 0; c < channels; c++) sum += interleaved[at + c];
                mono[f] = sum * each;
            }
        }

        static int Ended(string reason)
        {
            Event("ended", "reason", reason);
            return ExitEnded;
        }

        static void Check(int hr, string what)
        {
            if (hr != 0) throw new COMException(what + " 0x" + hr.ToString("X8"), hr);
        }

        static string IdOf(IMMDevice device)
        {
            string id;
            Check(device.GetId(out id), "GetId");
            return id;
        }

        static readonly PropertyKey FriendlyName =
            new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
        const ushort VT_LPWSTR = 31;

        static string NameOf(IMMDevice device)
        {
            IPropertyStore store;
            if (device.OpenPropertyStore(0, out store) != 0) return "";
            PropertyKey key = FriendlyName;
            PropVariant value;
            if (store.GetValue(ref key, out value) != 0) return "";
            try
            {
                return value.vt == VT_LPWSTR ? Marshal.PtrToStringUni(value.pointer) : "";
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }

        static void Event(string name, string key, string value)
        {
            Line("{\"event\":" + Quote(name) + ",\"" + key + "\":" + Quote(value) + "}");
        }

        static void Event3(string name, string k1, int v1, string k2, int v2, string k3, string v3)
        {
            Line("{\"event\":" + Quote(name) + ",\"" + k1 + "\":" + v1 + ",\"" + k2 + "\":" + v2 +
                ",\"" + k3 + "\":" + Quote(v3) + "}");
        }

        static void Line(string json)
        {
            lock (ErrLock)
            {
                Console.Error.WriteLine(json);
                Console.Error.Flush();
            }
        }

        static string Quote(string text)
        {
            StringBuilder s = new StringBuilder("\"");
            foreach (char ch in text)
            {
                if (ch == '"') s.Append("\\\"");
                else if (ch == '\\') s.Append("\\\\");
                else if (ch < 0x20) s.Append("\\u").Append(((int)ch).ToString("x4"));
                else s.Append(ch);
            }
            return s.Append('"').ToString();
        }

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant value);
    }

    enum EDataFlow { Render = 0, Capture = 1, All = 2 }
    enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
    }

    // 16 bytes on 32-bit Windows and 24 on 64-bit; sized for the larger.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointer;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags,
            out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
