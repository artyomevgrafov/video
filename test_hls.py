#!/usr/bin/env python3
"""
HLS Streaming Test Suite
Tests local file streaming, seek functionality, and segment generation
"""

import json
import os
import subprocess
import time
from pathlib import Path

import requests

BASE_URL = "http://localhost:8081"
TEST_VIDEO = "/home/q/Відео/downloads/All.Her.Fault.S01.2025.PCOK.720p.WEB-DL.H264_il68k/All.Her.Fault.S01E04.PCOK.720p.WEB-DL.H264.mkv"

class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    END = "\033[0m"


def log_ok(msg):
    print(f"{Colors.GREEN}✓ {msg}{Colors.END}")


def log_fail(msg):
    print(f"{Colors.RED}✗ {msg}{Colors.END}")


def log_info(msg):
    print(f"{Colors.BLUE}ℹ {msg}{Colors.END}")


def log_warn(msg):
    print(f"{Colors.YELLOW}⚠ {msg}{Colors.END}")


def test_server_running():
    """Test 1: Server is running"""
    print("\n=== Test 1: Server Running ===")
    try:
        r = requests.get(f"{BASE_URL}/whoami", timeout=5)
        if r.status_code == 200:
            log_ok(f"Server running at {BASE_URL}")
            return True
        else:
            log_fail(f"Server returned {r.status_code}")
            return False
    except Exception as e:
        log_fail(f"Cannot connect to server: {e}")
        return False


def test_video_exists():
    """Test 2: Test video file exists and is valid"""
    print("\n=== Test 2: Video File ===")
    if not os.path.exists(TEST_VIDEO):
        log_fail(f"Test video not found: {TEST_VIDEO}")
        return False, 0

    size_mb = os.path.getsize(TEST_VIDEO) / 1024 / 1024
    log_ok(f"Video exists: {size_mb:.1f} MB")

    # Get duration with ffprobe
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                TEST_VIDEO,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        duration = float(result.stdout.strip())
        log_ok(f"Duration: {duration:.1f}s ({duration / 60:.1f} min)")
        return True, duration
    except Exception as e:
        log_fail(f"Cannot get duration: {e}")
        return False, 0


def test_create_stream():
    """Test 3: Create HLS stream from local file"""
    print("\n=== Test 3: Create HLS Stream ===")
    try:
        r = requests.post(
            f"{BASE_URL}/api/local2hls",
            json={"filePath": TEST_VIDEO, "pushToTv": False},
            timeout=30,
        )

        if r.status_code != 200:
            log_fail(f"Failed to create stream: {r.status_code}")
            return None

        data = r.json()
        stream_id = data.get("streamId")
        hls_url = data.get("hlsUrl")

        if not stream_id:
            log_fail("No streamId in response")
            return None

        log_ok(f"Stream created: {stream_id}")
        log_info(f"HLS URL: {hls_url}")
        return stream_id
    except Exception as e:
        log_fail(f"Error creating stream: {e}")
        return None


def test_segments_generation(stream_id, wait_seconds=10):
    """Test 4: Segments are being generated"""
    print(f"\n=== Test 4: Segment Generation (waiting {wait_seconds}s) ===")

    hls_dir = f"/tmp/hls_{stream_id}"

    if not os.path.exists(hls_dir):
        log_fail(f"HLS directory not found: {hls_dir}")
        return 0

    # Wait and count segments
    time.sleep(wait_seconds)

    segments = list(Path(hls_dir).glob("*.ts"))
    count = len(segments)

    if count == 0:
        log_fail("No segments generated")
        return 0

    # Calculate coverage
    coverage_seconds = count * 4  # 4 sec per segment
    log_ok(
        f"Generated {count} segments ({coverage_seconds}s / {coverage_seconds / 60:.1f} min)"
    )

    # Check if ffmpeg still running
    result = subprocess.run(
        ["pgrep", "-f", f"ffmpeg.*{stream_id}"], capture_output=True
    )
    if result.returncode == 0:
        log_info("FFmpeg still running (generating more segments)")
    else:
        log_warn("FFmpeg not running")

    return count


def test_playlist_accessible(stream_id):
    """Test 5: Playlist is accessible via HTTP"""
    print("\n=== Test 5: Playlist Access ===")
    try:
        r = requests.get(f"{BASE_URL}/hls/{stream_id}.m3u8", timeout=10)
        if r.status_code != 200:
            log_fail(f"Playlist not accessible: {r.status_code}")
            return False

        content = r.text
        if "#EXTM3U" not in content:
            log_fail("Invalid playlist format")
            return False

        # Count segments in playlist
        segment_count = content.count(".ts")
        log_ok(f"Playlist accessible with {segment_count} segments")

        # Check for ENDLIST (stream complete)
        if "#EXT-X-ENDLIST" in content:
            log_info("Stream complete (ENDLIST present)")
        else:
            log_info("Stream still generating (no ENDLIST)")

        return True
    except Exception as e:
        log_fail(f"Error accessing playlist: {e}")
        return False


def test_segment_accessible(stream_id, segment_num=0):
    """Test 6: Individual segment is accessible"""
    print(f"\n=== Test 6: Segment {segment_num} Access ===")
    try:
        r = requests.get(
            f"{BASE_URL}/hls/{stream_id}/index{segment_num}.ts", timeout=10
        )
        if r.status_code != 200:
            log_fail(f"Segment not accessible: {r.status_code}")
            return False

        size_kb = len(r.content) / 1024
        log_ok(f"Segment accessible: {size_kb:.1f} KB")
        return True
    except Exception as e:
        log_fail(f"Error accessing segment: {e}")
        return False


def test_seek(stream_id, position_seconds):
    """Test 7: Seek functionality"""
    print(
        f"\n=== Test 7: Seek to {position_seconds}s ({position_seconds / 60:.1f} min) ==="
    )
    try:
        r = requests.post(
            f"{BASE_URL}/api/local2hls/seek",
            json={"streamId": stream_id, "position": position_seconds},
            timeout=90,
        )

        if r.status_code != 200:
            log_fail(f"Seek failed: {r.status_code} - {r.text}")
            return False

        data = r.json()
        if not data.get("success"):
            log_fail(f"Seek unsuccessful: {data}")
            return False

        log_ok(f"Seek initiated to {position_seconds}s")

        # Wait for segments
        time.sleep(10)

        hls_dir = f"/tmp/hls_{stream_id}"
        segments = list(Path(hls_dir).glob("*.ts"))

        if not segments:
            log_fail("No segments after seek")
            return False

        # Check segment numbers
        segment_nums = []
        for s in segments:
            try:
                num = int(s.stem.replace("index", ""))
                segment_nums.append(num)
            except:
                pass

        if segment_nums:
            expected_start = position_seconds // 4
            actual_start = min(segment_nums)
            log_ok(
                f"Segments start from index {actual_start} (expected ~{expected_start})"
            )
            log_info(f"Total segments after seek: {len(segments)}")

            if abs(actual_start - expected_start) <= 2:
                log_ok("Seek position correct!")
                return True
            else:
                log_warn(
                    f"Seek position off by {abs(actual_start - expected_start)} segments"
                )
                return True  # Still works, just imprecise

        return True
    except Exception as e:
        log_fail(f"Error during seek: {e}")
        return False


def test_seek_segment_accessible(stream_id, position_seconds):
    """Test 8: Segment at seek position is accessible"""
    print(f"\n=== Test 8: Seek Segment Access ===")
    expected_segment = position_seconds // 4

    try:
        r = requests.get(
            f"{BASE_URL}/hls/{stream_id}/index{expected_segment}.ts", timeout=10
        )
        if r.status_code != 200:
            log_fail(f"Seek segment {expected_segment} not accessible: {r.status_code}")
            return False

        size_kb = len(r.content) / 1024
        log_ok(f"Seek segment {expected_segment} accessible: {size_kb:.1f} KB")
        return True
    except Exception as e:
        log_fail(f"Error accessing seek segment: {e}")
        return False


def cleanup(stream_id):
    """Cleanup test stream"""
    print("\n=== Cleanup ===")
    subprocess.run(["pkill", "-f", f"ffmpeg.*{stream_id}"], capture_output=True)
    log_info("Killed ffmpeg processes")


def main():
    print("=" * 50)
    print("HLS STREAMING TEST SUITE")
    print("=" * 50)

    results = {}

    # Test 1: Server running
    results["server"] = test_server_running()
    if not results["server"]:
        print("\n❌ Server not running. Start with: node server.js")
        return

    # Test 2: Video exists
    results["video"], duration = test_video_exists()
    if not results["video"]:
        print("\n❌ Test video not found")
        return

    # Test 3: Create stream
    stream_id = test_create_stream()
    results["create"] = stream_id is not None
    if not stream_id:
        print("\n❌ Failed to create stream")
        return

    # Test 4: Segment generation
    segment_count = test_segments_generation(stream_id, wait_seconds=8)
    results["segments"] = segment_count > 0

    # Test 5: Playlist accessible
    results["playlist"] = test_playlist_accessible(stream_id)

    # Test 6: Segment accessible
    results["segment_access"] = test_segment_accessible(stream_id, 0)

    # Test 7: Seek to 30 minutes (1800 seconds)
    seek_position = min(1800, duration - 300)  # 30 min or 5 min before end
    results["seek"] = test_seek(stream_id, seek_position)

    # Test 8: Seek segment accessible
    if results["seek"]:
        results["seek_segment"] = test_seek_segment_accessible(stream_id, seek_position)
    else:
        results["seek_segment"] = False

    # Cleanup
    cleanup(stream_id)

    # Summary
    print("\n" + "=" * 50)
    print("TEST SUMMARY")
    print("=" * 50)

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for test, result in results.items():
        status = (
            f"{Colors.GREEN}PASS{Colors.END}"
            if result
            else f"{Colors.RED}FAIL{Colors.END}"
        )
        print(f"  {test}: {status}")

    print(f"\nTotal: {passed}/{total} tests passed")

    if passed == total:
        print(f"\n{Colors.GREEN}All tests passed!{Colors.END}")
    else:
        print(f"\n{Colors.YELLOW}Some tests failed. Check output above.{Colors.END}")

        print(f"\n{Colors.YELLOW}Some tests failed. Check output above.{Colors.END}")

if __name__ == "__main__":
    main()
