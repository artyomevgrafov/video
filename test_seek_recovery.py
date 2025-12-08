#!/usr/bin/env python3
"""
Test seek recovery scenario:
1. Start stream
2. Simulate seek to position where segments don't exist
3. Call seek endpoint (like TV player would)
4. Verify segments now exist at that position
"""

import os
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


def log(msg, color=Colors.BLUE):
    print(f"{color}{msg}{Colors.END}")


def test_seek_recovery():
    print("=" * 60)
    print("SEEK RECOVERY TEST")
    print("Simulates what happens when user seeks forward in video")
    print("=" * 60)

    # Step 1: Create stream
    log("\n[1] Creating HLS stream...")
    r = requests.post(
        f"{BASE_URL}/api/local2hls",
        json={"filePath": TEST_VIDEO, "pushToTv": False},
        timeout=30,
    )

    if r.status_code != 200:
        log(f"Failed to create stream: {r.text}", Colors.RED)
        return False

    data = r.json()
    stream_id = data["streamId"]
    log(f"    Stream: {stream_id}", Colors.GREEN)

    # Step 2: Wait for initial segments
    log("\n[2] Waiting for initial segments (5s)...")
    time.sleep(5)

    hls_dir = f"/tmp/hls_{stream_id}"
    initial_segments = list(Path(hls_dir).glob("*.ts"))
    log(f"    Initial segments: {len(initial_segments)}", Colors.GREEN)

    # Step 3: Check segment at 35 min (doesn't exist yet)
    seek_position = 2100  # 35 minutes
    expected_segment = seek_position // 4  # = 525

    log(f"\n[3] Checking if segment {expected_segment} exists (35 min)...")
    r = requests.get(
        f"{BASE_URL}/hls/{stream_id}/index{expected_segment}.ts", timeout=5
    )

    if r.status_code == 200:
        log(f"    Segment already exists (stream was fast)", Colors.YELLOW)
    else:
        log(f"    Segment NOT found (404) - this is expected!", Colors.GREEN)

    # Step 4: Simulate what TV player does - call seek endpoint
    log(f"\n[4] Calling /api/local2hls/seek (like TV player would)...")
    log(f"    Seeking to {seek_position}s ({seek_position / 60:.1f} min)...")

    start_time = time.time()
    r = requests.post(
        f"{BASE_URL}/api/local2hls/seek",
        json={"streamId": stream_id, "position": seek_position},
        timeout=120,
    )
    elapsed = time.time() - start_time

    if r.status_code != 200:
        log(f"    Seek failed: {r.text}", Colors.RED)
        return False

    log(f"    Seek completed in {elapsed:.1f}s", Colors.GREEN)

    # Step 5: Wait for segments to generate
    log("\n[5] Waiting for segments after seek (10s)...")
    time.sleep(10)

    # Step 6: Check segment at seek position
    log(f"\n[6] Checking segment {expected_segment} now...")
    r = requests.get(
        f"{BASE_URL}/hls/{stream_id}/index{expected_segment}.ts", timeout=5
    )

    if r.status_code == 200:
        size_kb = len(r.content) / 1024
        log(
            f"    SUCCESS! Segment {expected_segment} now exists ({size_kb:.1f} KB)",
            Colors.GREEN,
        )
    else:
        log(f"    FAILED! Segment still not found: {r.status_code}", Colors.RED)
        return False

    # Step 7: Check playlist
    log("\n[7] Checking playlist...")
    r = requests.get(f"{BASE_URL}/hls/{stream_id}.m3u8", timeout=5)

    if r.status_code == 200:
        content = r.text
        # Check MEDIA-SEQUENCE
        if f"#EXT-X-MEDIA-SEQUENCE:{expected_segment}" in content:
            log(f"    Playlist starts from segment {expected_segment}", Colors.GREEN)
        else:
            # Find actual sequence
            import re

            match = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", content)
            if match:
                log(f"    Playlist starts from segment {match.group(1)}", Colors.GREEN)

        segment_count = content.count(".ts")
        log(f"    Total segments in playlist: {segment_count}", Colors.GREEN)

    # Step 8: Verify playback would work
    log("\n[8] Simulating player requesting segments...")
    success_count = 0
    for i in range(5):
        seg_num = expected_segment + i
        r = requests.get(f"{BASE_URL}/hls/{stream_id}/index{seg_num}.ts", timeout=5)
        status = "OK" if r.status_code == 200 else "MISSING"
        if r.status_code == 200:
            success_count += 1
        log(f"    Segment {seg_num}: {status}")

    # Cleanup
    log("\n[9] Cleanup...")
    os.system(f"pkill -f 'ffmpeg.*{stream_id}' 2>/dev/null")

    # Summary
    print("\n" + "=" * 60)
    if success_count >= 3:
        log("TEST PASSED! Seek recovery works correctly.", Colors.GREEN)
        log("When user seeks forward, TV player will:", Colors.BLUE)
        log("  1. Get 404 error for missing segment", Colors.BLUE)
        log("  2. Call /api/local2hls/seek", Colors.BLUE)
        log("  3. Wait for new segments", Colors.BLUE)
        log("  4. Resume playback from seek position", Colors.BLUE)
        return True
    else:
        log("TEST FAILED! Not enough segments after seek.", Colors.RED)
        return False


if __name__ == "__main__":
    try:
        success = test_seek_recovery()
        exit(0 if success else 1)
    except Exception as e:
        print(f"\n{Colors.RED}Error: {e}{Colors.END}")
        exit(1)
