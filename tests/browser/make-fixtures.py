"""Synthetic, credential-free media used by HTTPS browser/TV qualification."""
import argparse
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=pathlib.Path)
parser.add_argument("--soak", action="store_true")
parser.add_argument("--hd", action="store_true")
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)

def ff(name, extra, seconds="12", size="1280x720", rate="30"):
    target = args.directory / name
    if target.exists():
        return
    command = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}",
               "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", seconds,
               "-map", "0:v", "-map", "1:a", "-ac", "2"]
    subprocess.run(command + extra + [str(target)], check=True, stdout=subprocess.DEVNULL)

h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac"]
ff("h264-aac.mkv", h264)
ff("h264-aac.mp4", h264 + ["-movflags", "+faststart"])
ff("h264-ac3.mkv", h264[:-1] + ["ac3"])
ff("h264-eac3.mkv", h264[:-1] + ["eac3"])
ff("h264-dts.mkv", h264[:-1] + ["dca", "-strict", "-2"])
ff("long-gop.mkv", h264 + ["-g", "300", "-keyint_min", "300", "-sc_threshold", "0"], seconds="24")
ff('mpeg2.mkv', ['-c:v', 'mpeg2video', '-q:v', '3', '-c:a', 'mp2'], seconds='6', size='640x360', rate='25')
ff('h264-avi.avi', h264)
ff("h264-1080p60.mkv", h264 + ["-g", "120"], size="1920x1080", rate="60")
for name, pix in [("hevc-main", "yuv420p"), ("hevc-main10", "yuv420p10le")]:
    ff(name + ".mkv", ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:pools=4:frame-threads=2:keyint=60", "-pix_fmt", pix, "-c:a", "aac"])
ff("av1.mkv", ["-c:v", "libaom-av1", "-cpu-used", "8", "-row-mt", "1", "-crf", "40", "-c:a", "aac"], seconds="4", size="640x360")
multi = args.directory / 'multi-audio.mkv'
if not multi.exists():
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(args.directory / 'h264-aac.mkv'), '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '12', '-map', '0:v', '-map', '0:a', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=spa', str(multi)], check=True)
live = args.directory / 'live'
live.mkdir(exist_ok=True)
if not (live / 'index.m3u8').exists():
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-stream_loop', '-1', '-i', str(args.directory / 'h264-aac.mkv'), '-t', '60', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_flags', 'independent_segments', '-hls_segment_filename', str(live / 'segment-%03d.ts'), str(live / 'index.m3u8')], check=True)
caption = args.directory / 'caption.srt'
small = args.directory / 'small'
small.mkdir(exist_ok=True)
if not (small / 'index.m3u8').exists():
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-stream_loop', '-1', '-i', str(args.directory / 'h264-aac.mkv'), '-t', '60', '-vf', 'scale=640:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-sc_threshold', '0', '-c:a', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_flags', 'independent_segments', '-hls_segment_filename', str(small / 'segment-%03d.ts'), str(small / 'index.m3u8')], check=True)
(args.directory / 'master.m3u8').write_text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2"\nlive/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"\nsmall/index.m3u8\n')
caption.write_text('1\n00:00:01,000 --> 00:00:03,000\nVIPTV caption one\n\n2\n00:00:08,000 --> 00:00:10,000\nVIPTV caption two\n')
if not (args.directory / 'subtitles.mkv').exists():
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(args.directory / 'h264-aac.mkv'), '-i', str(caption), '-map', '0', '-map', '1:0', '-c', 'copy', '-metadata:s:s:0', 'language=eng', str(args.directory / 'subtitles.mkv')], check=True)
if args.soak:
    target = args.directory / "soak.mkv"
    if not target.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-stream_loop", "-1", "-i", str(args.directory / "h264-aac.mkv"), "-t", "1900", "-c", "copy", str(target)], check=True)
if args.hd:
    ff('h264-1080p30.mkv', h264, seconds='6', size='1920x1080')
    for name, pix in [('hevc-4k-main', 'yuv420p'), ('hevc-4k-main10', 'yuv420p10le')]:
        ff(name + '.mkv', ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=4:frame-threads=2:keyint=48', '-pix_fmt', pix, '-c:a', 'aac'], seconds='6', size='3840x2160', rate='24')
print(args.directory)
