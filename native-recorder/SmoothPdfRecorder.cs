// Smooth PDF Reader: local, explicit-inline-action microphone capture.
// No microphone is accessed by --self-test, startup, or anything except a start command.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace SmoothPdfRecorder
{
    internal static class Program
    {
        internal const int SampleRate = 16000;
        internal const int MaxSeconds = 120;
        internal const int MaxSamples = SampleRate * MaxSeconds;
        internal const int LeaseMilliseconds = 8000;
        private static readonly object OutputLock = new object();

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTests.Run();
            int parentId = 0;
            if (args.Length != 0 && (args.Length != 2 || args[0] != "--parent-pid" ||
                !int.TryParse(args[1], out parentId) || parentId <= 0))
            { Emit("error", null, "INVALID_ARGUMENT", "Invalid recorder arguments."); return 2; }
            try
            {
                using (RecorderContext context = new RecorderContext(parentId)) Application.Run(context);
                return 0;
            }
            catch { Emit("error", null, "RECORDER_UNAVAILABLE", "The local recorder could not start."); return 1; }
        }

        internal static void Emit(string name, string session, string code, string message)
        {
            Dictionary<string, object> data = new Dictionary<string, object>();
            data["event"] = name;
            if (session != null) data["sessionId"] = session;
            if (code != null) data["code"] = code;
            if (message != null) data["message"] = message;
            Emit(data);
        }
        internal static void Emit(Dictionary<string, object> data)
        {
            lock (OutputLock)
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 6000000;
                Console.Out.WriteLine(serializer.Serialize(data));
                Console.Out.Flush();
            }
        }
        internal static double MillisecondsSince(long stamp)
        { return (Stopwatch.GetTimestamp() - stamp) * 1000.0 / Stopwatch.Frequency; }
    }

    internal sealed class Command
    {
        internal string Op;
        internal string SessionId;
        internal static bool TryParse(string text, out Command command)
        {
            command = null;
            if (text == null || text.Length > 256) return false;
            try
            {
                // Exact simple grammar also rejects duplicate properties and hidden arguments.
                Match m = Regex.Match(text, "^\\s*\\{\\s*\"op\"\\s*:\\s*\"(start|stop|cancel|heartbeat|shutdown)\"\\s*(?:,\\s*\"sessionId\"\\s*:\\s*\"([A-Za-z0-9_-]{16,80})\"\\s*)?\\}\\s*$", RegexOptions.CultureInvariant);
                if (!m.Success) return false;
                string op = m.Groups[1].Value;
                string session = m.Groups[2].Success ? m.Groups[2].Value : null;
                if ((op == "shutdown") != (session == null)) return false;
                command = new Command { Op = op, SessionId = session };
                return true;
            }
            catch { return false; }
        }
    }

    internal enum RecorderState { Idle, Recording, Stopping, Exiting }

    internal sealed class RecorderContext : ApplicationContext
    {
        // A never-visible control supplies an STA message dispatcher; there is no native UI.
        private readonly Control dispatcher;
        private readonly System.Windows.Forms.Timer timer;
        private readonly Process parent;
        private RecorderState state = RecorderState.Idle;
        private bool closing;
        private string session;
        private long heartbeat;
        private CaptureWorker worker;

        internal RecorderContext(int parentId)
        {
            if (parentId > 0) parent = Process.GetProcessById(parentId);
            dispatcher = new Control();
            dispatcher.Visible = false;
            // No Form, Show/Activate call, taskbar entry, or audio device is created here.
            IntPtr handle = dispatcher.Handle;
            timer = new System.Windows.Forms.Timer { Interval = 250 };
            timer.Tick += delegate { Tick(); };
            timer.Start();
            Thread input = new Thread(ReadCommands) { IsBackground = true, Name = "Recorder commands" };
            input.Start();
            Program.Emit(new Dictionary<string, object> { { "event", "ready" }, { "protocolVersion", 1 }, { "interactionMode", "inline-only" } });
        }

        private void Dispatch(Action action)
        {
            try { if (!closing && !dispatcher.IsDisposed) dispatcher.BeginInvoke(action); } catch { }
        }
        private void ReadCommands()
        {
            try
            {
                // Never let an oversized command allocate unbounded memory.
                StringBuilder line = new StringBuilder(256);
                int ch;
                while ((ch = Console.In.Read()) >= 0)
                {
                    if (ch == '\n')
                    {
                        string value = line.ToString(); line.Length = 0;
                        Command command;
                        if (!Command.TryParse(value, out command)) { Dispatch(delegate { ProtocolError(); }); continue; }
                        Command queued = command; Dispatch(delegate { Handle(queued); });
                    }
                    else if (ch != '\r')
                    {
                        if (line.Length >= 256) { Dispatch(delegate { Shutdown(); }); return; }
                        line.Append((char)ch);
                    }
                }
            }
            catch { }
            Dispatch(delegate { Shutdown(); });
        }
        private void ProtocolError()
        { Program.Emit("error", null, "INVALID_COMMAND", "Invalid recorder command."); }
        private void Handle(Command command)
        {
            if (state == RecorderState.Exiting) return;
            if (command.Op == "shutdown") { Shutdown(); return; }
            if (command.Op == "start")
            {
                if (state != RecorderState.Idle) { Program.Emit("error", command.SessionId, "RECORDER_BUSY", "Another recording is already active."); return; }
                session = command.SessionId; heartbeat = Stopwatch.GetTimestamp();
                BeginCapture();
                return;
            }
            if (session == null || command.SessionId != session)
            { Program.Emit("error", command.SessionId, "STALE_SESSION", "This recording session is no longer active."); return; }
            if (command.Op == "heartbeat") { heartbeat = Stopwatch.GetTimestamp(); return; }
            if (command.Op == "cancel") { Cancel(); return; }
            if (command.Op == "stop")
            {
                if (state == RecorderState.Recording) Stop(false);
            }
        }
        private void BeginCapture()
        {
            // The plugin sends start only after the user explicitly clicks its inline microphone.
            // Windows privacy denial remains authoritative; no permission setting is changed.
            if (Program.MillisecondsSince(heartbeat) >= Program.LeaseMilliseconds)
            {
                string expired = session; session = null; state = RecorderState.Idle;
                Program.Emit("cancelled", expired, null, null); return;
            }
            state = RecorderState.Recording;
            string captureSession = session;
            worker = new CaptureWorker(
                delegate { Dispatch(delegate { if (session == captureSession && state == RecorderState.Recording) Program.Emit("recording", session, null, null); }); },
                delegate(CaptureResult result) { Dispatch(delegate { Complete(captureSession, result); }); });
            worker.Start();
        }
        private void Stop(bool discard)
        {
            if (worker == null) return;
            state = RecorderState.Stopping;
            worker.Stop(discard);
        }
        private void Cancel()
        {
            if (state == RecorderState.Recording || state == RecorderState.Stopping) { Stop(true); return; }
        }
        private void Complete(string captureSession, CaptureResult result)
        {
            if (closing || session != captureSession) return;
            // Cancellation can arrive after the worker queued its completion callback.
            if (worker != null && worker.CancelRequested)
            {
                if (result.Pcm != null) Array.Clear(result.Pcm, 0, result.Pcm.Length);
                result.Pcm = null; result.Cancelled = true;
            }
            worker = null; session = null; state = RecorderState.Idle;
            if (result.Cancelled) Program.Emit("cancelled", captureSession, null, null);
            else if (result.ErrorCode != null) Program.Emit("error", captureSession, result.ErrorCode, result.ErrorMessage);
            else
            {
                byte[] pcm = result.Pcm ?? new byte[0];
                Program.Emit(new Dictionary<string, object> {
                    { "event", "stopped" }, { "sessionId", captureSession },
                    { "pcmBase64", Convert.ToBase64String(pcm) },
                    { "samples", pcm.Length / 2 }, { "seconds", pcm.Length / 32000.0 }
                });
                Array.Clear(pcm, 0, pcm.Length);
            }
        }
        private void Tick()
        {
            try { if (parent != null && parent.HasExited) { Shutdown(); return; } } catch { Shutdown(); return; }
            if (state != RecorderState.Idle && state != RecorderState.Exiting && Program.MillisecondsSince(heartbeat) >= Program.LeaseMilliseconds)
            { Cancel(); return; }
            if (state == RecorderState.Recording && worker != null)
            {
                if (worker.ElapsedSeconds >= Program.MaxSeconds) { Stop(false); return; }
            }
        }
        private void Shutdown()
        {
            if (closing) return;
            closing = true; state = RecorderState.Exiting; timer.Stop();
            if (worker != null) { worker.Stop(true); worker.Join(2500); worker = null; }
            ExitThread();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Shutdown(); timer.Dispose(); dispatcher.Dispose();
                if (parent != null) parent.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class CaptureResult
    {
        internal bool Cancelled;
        internal byte[] Pcm;
        internal string ErrorCode;
        internal string ErrorMessage;
    }

    internal sealed class CaptureWorker
    {
        private readonly Action started;
        private readonly Action<CaptureResult> completed;
        private readonly Thread thread;
        private readonly ManualResetEvent stopEvent = new ManualResetEvent(false);
        private readonly object stopLock = new object();
        private bool finished;
        private int discard;
        private long startedAt;
        internal CaptureWorker(Action started, Action<CaptureResult> completed)
        {
            this.started = started; this.completed = completed;
            thread = new Thread(Run) { IsBackground = true, Name = "Local microphone capture" };
            thread.SetApartmentState(ApartmentState.MTA);
        }
        internal double ElapsedSeconds { get { long stamp = Interlocked.Read(ref startedAt); return stamp == 0 ? 0 : Program.MillisecondsSince(stamp) / 1000.0; } }
        internal bool CancelRequested { get { return Interlocked.CompareExchange(ref discard, 0, 0) != 0; } }
        internal void Start() { thread.Start(); }
        internal void Stop(bool cancel)
        {
            if (cancel) Interlocked.Exchange(ref discard, 1);
            lock (stopLock) { if (!finished) stopEvent.Set(); }
        }
        internal void Join(int milliseconds) { thread.Join(milliseconds); }
        private void Run()
        {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            IntPtr formatPointer = IntPtr.Zero;
            PcmConverter converter = null;
            bool streamStarted = false;
            Mutex microphoneMutex = null;
            bool mutexOwned = false;
            CaptureResult result = new CaptureResult();
            try
            {
                if (stopEvent.WaitOne(0)) { result.Cancelled = true; return; }
                microphoneMutex = new Mutex(false, "Local\\SmoothPdfReader_MicrophoneCapture_v1");
                try { mutexOwned = microphoneMutex.WaitOne(0); } catch (AbandonedMutexException) { mutexOwned = true; }
                if (!mutexOwned) throw new RecorderBusyException();
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                Check(enumerator.GetDefaultAudioEndpoint(1, 0, out device)); // eCapture, eConsole: never loopback.
                Guid audioClientId = typeof(IAudioClient).GUID;
                object activated;
                Check(device.Activate(ref audioClientId, 23, IntPtr.Zero, out activated));
                client = (IAudioClient)activated;
                Check(client.GetMixFormat(out formatPointer));
                AudioFormat format = AudioFormat.Read(formatPointer);
                converter = new PcmConverter(format);
                // Shared mode, native mix format, no loopback/exclusive/raw/fallback APIs.
                Check(client.Initialize(0, 0, 1000000, 0, formatPointer, IntPtr.Zero));
                Guid captureId = typeof(IAudioCaptureClient).GUID;
                object service;
                Check(client.GetService(ref captureId, out service)); capture = (IAudioCaptureClient)service;
                if (stopEvent.WaitOne(0)) { result.Cancelled = true; return; }
                Check(client.Start()); streamStarted = true;
                Interlocked.Exchange(ref startedAt, Stopwatch.GetTimestamp()); started();
                while (!stopEvent.WaitOne(10) && ElapsedSeconds < Program.MaxSeconds && converter.Samples < Program.MaxSamples)
                {
                    uint packet;
                    Check(capture.GetNextPacketSize(out packet));
                    while (packet > 0 && !stopEvent.WaitOne(0) && ElapsedSeconds < Program.MaxSeconds && converter.Samples < Program.MaxSamples)
                    {
                        IntPtr data; uint frames, flags; ulong position, counter;
                        Check(capture.GetBuffer(out data, out frames, out flags, out position, out counter));
                        try
                        {
                            if (frames > 262144 || ((long)frames * format.BlockAlign) > 16777216) throw new InvalidOperationException("Invalid audio packet.");
                            byte[] bytes = new byte[checked((int)frames * format.BlockAlign)];
                            if ((flags & 2) == 0 && bytes.Length > 0) Marshal.Copy(data, bytes, 0, bytes.Length);
                            else if (!format.Float && format.Bits == 8) for (int i = 0; i < bytes.Length; i++) bytes[i] = 128;
                            converter.Append(bytes, (int)frames);
                            Array.Clear(bytes, 0, bytes.Length);
                        }
                        finally { Check(capture.ReleaseBuffer(frames)); }
                        Check(capture.GetNextPacketSize(out packet));
                    }
                }
                // Release the physical microphone before returning any captured data.
                Check(client.Stop()); streamStarted = false;
                if (Interlocked.CompareExchange(ref discard, 0, 0) != 0) result.Cancelled = true;
                else result.Pcm = converter.Finish();
            }
            catch (COMException ex)
            {
                result.ErrorCode = ex.ErrorCode == unchecked((int)0x80070005) ? "MICROPHONE_DENIED" : "MICROPHONE_UNAVAILABLE";
                result.ErrorMessage = result.ErrorCode == "MICROPHONE_DENIED" ? "Windows denied microphone access. Check microphone privacy settings." : "The default microphone is unavailable or was disconnected.";
            }
            catch (NotSupportedException)
            { result.ErrorCode = "AUDIO_FORMAT_UNSUPPORTED"; result.ErrorMessage = "The default microphone uses an unsupported audio format."; }
            catch (RecorderBusyException)
            { result.ErrorCode = "RECORDER_BUSY"; result.ErrorMessage = "Another Smooth PDF Reader window is already recording."; }
            catch
            { result.ErrorCode = "RECORDING_FAILED"; result.ErrorMessage = "The local recording could not be completed."; }
            finally
            {
                if (streamStarted && client != null) { try { client.Stop(); } catch { } }
                if (formatPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(formatPointer);
                Release(capture); Release(client); Release(device); Release(enumerator);
                if (mutexOwned) microphoneMutex.ReleaseMutex();
                if (microphoneMutex != null) microphoneMutex.Dispose();
                if (converter != null) converter.Dispose();
                if (Interlocked.CompareExchange(ref discard, 0, 0) != 0)
                {
                    if (result.Pcm != null) Array.Clear(result.Pcm, 0, result.Pcm.Length);
                    result.Pcm = null; result.Cancelled = true; result.ErrorCode = null; result.ErrorMessage = null;
                }
                lock (stopLock) { finished = true; stopEvent.Dispose(); }
                completed(result);
            }
        }
        private static void Check(int hresult) { if (hresult < 0) Marshal.ThrowExceptionForHR(hresult); }
        private static void Release(object value) { if (value != null && Marshal.IsComObject(value)) { try { Marshal.ReleaseComObject(value); } catch { } } }
    }

    internal sealed class RecorderBusyException : Exception { }

    internal sealed class AudioFormat
    {
        internal int Rate, Channels, Bits, BlockAlign;
        internal bool Float;
        internal static AudioFormat Read(IntPtr p)
        {
            int tag = (ushort)Marshal.ReadInt16(p, 0);
            AudioFormat f = new AudioFormat {
                Channels = (ushort)Marshal.ReadInt16(p, 2), Rate = Marshal.ReadInt32(p, 4),
                BlockAlign = (ushort)Marshal.ReadInt16(p, 12), Bits = (ushort)Marshal.ReadInt16(p, 14)
            };
            if (tag == 65534)
            {
                if ((ushort)Marshal.ReadInt16(p, 16) < 22) throw new NotSupportedException();
                Guid sub = (Guid)Marshal.PtrToStructure(IntPtr.Add(p, 24), typeof(Guid));
                if (sub == new Guid("00000001-0000-0010-8000-00aa00389b71")) tag = 1;
                else if (sub == new Guid("00000003-0000-0010-8000-00aa00389b71")) tag = 3;
                else throw new NotSupportedException();
            }
            f.Float = tag == 3;
            if ((tag != 1 && tag != 3) || f.Rate < 8000 || f.Rate > 192000 || f.Channels < 1 || f.Channels > 32 ||
                (f.Float ? f.Bits != 32 && f.Bits != 64 : f.Bits != 8 && f.Bits != 16 && f.Bits != 24 && f.Bits != 32) ||
                f.BlockAlign != f.Channels * (f.Bits / 8)) throw new NotSupportedException();
            return f;
        }
    }

    internal sealed class PcmConverter : IDisposable
    {
        private const int Radius = 32;
        private readonly AudioFormat format;
        private readonly List<double> buffer = new List<double>();
        private readonly MemoryStream output = new MemoryStream();
        private long firstFrame;
        private long totalFrames;
        internal int Samples { get { return (int)(output.Length / 2); } }
        internal PcmConverter(AudioFormat format) { this.format = format; }
        internal void Append(byte[] data, int frames)
        {
            if (frames < 0 || data.Length != checked(frames * format.BlockAlign)) throw new ArgumentException();
            if (Samples >= Program.MaxSamples) return;
            for (int frame = 0; frame < frames; frame++)
            {
                double sum = 0;
                for (int channel = 0; channel < format.Channels; channel++)
                {
                    int offset = frame * format.BlockAlign + channel * (format.Bits / 8);
                    double value;
                    if (format.Float) value = format.Bits == 32 ? BitConverter.ToSingle(data, offset) : BitConverter.ToDouble(data, offset);
                    else if (format.Bits == 8) value = (data[offset] - 128) / 128.0;
                    else if (format.Bits == 16) value = BitConverter.ToInt16(data, offset) / 32768.0;
                    else if (format.Bits == 24) value = ((data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16) << 8 >> 8) / 8388608.0;
                    else value = BitConverter.ToInt32(data, offset) / 2147483648.0;
                    if (double.IsNaN(value) || double.IsInfinity(value)) value = 0;
                    sum += Math.Max(-1, Math.Min(1, value));
                }
                buffer.Add(sum / format.Channels);
            }
            totalFrames += frames;
            Produce(false);
        }
        private void Produce(bool final)
        {
            long limit = Math.Min(Program.MaxSamples, totalFrames * Program.SampleRate / format.Rate);
            double cutoff = Math.Min(1.0, (double)Program.SampleRate / format.Rate) * 0.90;
            while (Samples < limit)
            {
                double position = Samples * (double)format.Rate / Program.SampleRate;
                if (!final && position + Radius >= totalFrames) break;
                long middle = (long)Math.Floor(position);
                double sum = 0, weight = 0;
                for (long index = middle - Radius + 1; index <= middle + Radius; index++)
                {
                    double delta = position - index;
                    double x = cutoff * delta;
                    double sinc = Math.Abs(x) < 1e-12 ? 1 : Math.Sin(Math.PI * x) / (Math.PI * x);
                    double window = 0.42 + 0.5 * Math.Cos(Math.PI * delta / Radius) + 0.08 * Math.Cos(2 * Math.PI * delta / Radius);
                    double h = cutoff * sinc * window;
                    weight += h;
                    if (index >= firstFrame && index < totalFrames) sum += buffer[(int)(index - firstFrame)] * h;
                }
                double sample = weight == 0 ? 0 : sum / weight;
                int quantized = (int)Math.Round(Math.Max(-1, Math.Min(1, sample)) * (sample < 0 ? 32768 : 32767));
                output.WriteByte((byte)(quantized & 255)); output.WriteByte((byte)((quantized >> 8) & 255));
            }
            long keepFrom = Math.Max(firstFrame, (long)Math.Floor(Samples * (double)format.Rate / Program.SampleRate) - Radius);
            int remove = (int)Math.Min(buffer.Count, keepFrom - firstFrame);
            if (remove > 0) { buffer.RemoveRange(0, remove); firstFrame += remove; }
        }
        internal byte[] Finish() { Produce(true); return output.ToArray(); }
        public void Dispose()
        {
            byte[] data = output.GetBuffer(); Array.Clear(data, 0, data.Length); output.Dispose();
            for (int i = 0; i < buffer.Count; i++) buffer[i] = 0;
            buffer.Clear();
        }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object result);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint flags, long duration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
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
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    internal static class SelfTests
    {
        private static int count;
        private static void Check(bool condition, string name)
        { if (!condition) throw new Exception(name); count++; }
        internal static int Run()
        {
            try
            {
                Command command;
                Check(Command.TryParse("{\"op\":\"start\",\"sessionId\":\"0123456789abcdef\"}", out command) && command.Op == "start", "start parser");
                Check(Command.TryParse("{\"op\":\"shutdown\"}", out command), "shutdown parser");
                Check(!Command.TryParse("{\"op\":\"start\"}", out command), "no implicit session");
                Check(!Command.TryParse("{\"op\":\"start\",\"sessionId\":\"0123456789abcdef\",\"path\":\"x\"}", out command), "no extra arguments");
                Check(!Command.TryParse("{\"op\":\"start\",\"op\":\"shutdown\",\"sessionId\":\"0123456789abcdef\"}", out command), "duplicate rejected");
                Check(!Command.TryParse(new string('x', 257), out command), "bounded parser");
                AudioFormat f = new AudioFormat { Rate = 48000, Channels = 2, Bits = 32, BlockAlign = 8, Float = true };
                byte[] waveform = new byte[48000 * 8];
                for (int i = 0; i < 48000; i++)
                {
                    float value = (float)(0.6 * Math.Sin(2 * Math.PI * 1000 * i / 48000));
                    Buffer.BlockCopy(BitConverter.GetBytes(value), 0, waveform, i * 8, 4);
                    Buffer.BlockCopy(BitConverter.GetBytes(value), 0, waveform, i * 8 + 4, 4);
                }
                byte[] whole, split;
                using (PcmConverter c = new PcmConverter(f)) { c.Append(waveform, 48000); whole = c.Finish(); }
                Check(whole.Length == 32000, "48k stereo to16kmono length");
                using (PcmConverter c = new PcmConverter(f))
                {
                    for (int i = 0; i < 48000; i += 127)
                    {
                        int n = Math.Min(127, 48000 - i); byte[] chunk = new byte[n * 8]; Buffer.BlockCopy(waveform, i * 8, chunk, 0, chunk.Length); c.Append(chunk, n);
                    }
                    split = c.Finish();
                }
                Check(Convert.ToBase64String(whole) == Convert.ToBase64String(split), "packet-boundary invariant resampling");
                double energy = 0;
                for (int i = 200; i < whole.Length - 200; i += 2) energy += Math.Pow(BitConverter.ToInt16(whole, i) / 32768.0, 2);
                energy = Math.Sqrt(energy / ((whole.Length - 400) / 2));
                Check(energy > 0.41 && energy < 0.44, "speechband gain");
                byte[] high = new byte[48000 * 8];
                for (int i = 0; i < 48000; i++)
                {
                    float v = (float)(0.6 * Math.Sin(2 * Math.PI * 12000 * i / 48000));
                    Buffer.BlockCopy(BitConverter.GetBytes(v), 0, high, i * 8, 4); Buffer.BlockCopy(BitConverter.GetBytes(v), 0, high, i * 8 + 4, 4);
                }
                using (PcmConverter c = new PcmConverter(f)) { c.Append(high, 48000); high = c.Finish(); }
                double alias = 0;
                for (int i = 200; i < high.Length - 200; i += 2) alias += Math.Pow(BitConverter.ToInt16(high, i) / 32768.0, 2);
                Check(Math.Sqrt(alias / ((high.Length - 400) / 2)) < 0.005, "antialias filter");
                f = new AudioFormat { Rate = 16000, Channels = 1, Bits = 16, BlockAlign = 2, Float = false };
                using (PcmConverter c = new PcmConverter(f))
                {
                    byte[] silence = new byte[16000 * 2];
                    for (int i = 0; i < 122; i++) c.Append(silence, 16000);
                    byte[] capped = c.Finish(); Check(capped.Length == 3840000, "120second cap");
                    bool zero = true; for (int i = 0; i < capped.Length; i++) if (capped[i] != 0) zero = false;
                    Check(zero, "silence remains silent");
                }
                ManualResetEvent done = new ManualResetEvent(false); CaptureResult cancelled = null;
                CaptureWorker worker = new CaptureWorker(delegate { throw new Exception("must not open microphone"); }, delegate(CaptureResult result) { cancelled = result; done.Set(); });
                worker.Stop(true); worker.Start();
                Check(done.WaitOne(2000) && cancelled.Cancelled && cancelled.Pcm == null, "prestart cancellation never initializes microphone");
                worker.Join(1000);
                worker.Stop(false); worker.Stop(true);
                Check(worker.CancelRequested, "cancel remains idempotent after completion");
                done.Dispose();
                Program.Emit(new Dictionary<string, object> { { "event", "self-test" }, { "passed", count }, { "microphoneOpened", false } });
                return 0;
            }
            catch (Exception ex)
            { Program.Emit("error", null, "SELF_TEST_FAILED", ex.Message); return 1; }
        }
    }
}
