#!/usr/bin/env python3
"""
HLS Stress Test
Simulates real user behavior - multiple seeks, back and forth
"""

import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

BASE_URL = "http://localhost:8081"
TEST_VIDEO = "/home/q/Відео/downloads/All.Her.Fault.S01.2025.PCOK.720p.WEB-DL.H264_il68k/All.Her.Fault.S01E04.PCOK.720p.WEB-DL.H264.mkv"
VIDEO_DURATION = 3150  # 52.5 minutes


class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    END = "\033[0m"


stats = {
    "seeks": 0,
    "seek_success": 0,
    "seek_failed": 0,
    "seek_times": [],
    "segment_requests": 0,
    "segment_success": 0,
    "segment_404": 0,
}


def log(msg, color=Colors.BLUE):
    print(f"{color}{msg}{Colors.END}")


def create_stream():
    """Create initial stream"""
    r = requests.post(
        f"{BASE_URL}/api/local2hls",
        json={"filePath": TEST_VIDEO, "pushToTv": False},
        timeout=30,
    )

    if r.status_code == 200:
        return r.json()["streamId"]
    return None


def seek_to(stream_id, position):
    """Seek to position and measure time"""
    start = time.time()
    try:
        r = requests.post(
            f"{BASE_URL}/api/local2hls/seek",
            json={"streamId": stream_id, "position": position},
            timeout=120,
        )
        elapsed = time.time() - start

        stats["seeks"] += 1
        stats["seek_times"].append(elapsed)

        if r.status_code == 200:
            stats["seek_success"] += 1
            return True, elapsed
        else:
            stats["seek_failed"] += 1
            return False, elapsed
    except Exception as e:
        stats["seeks"] += 1
        stats["seek_failed"] += 1
        return False, time.time() - start


def check_segment(stream_id, segment_num):
    """Check if segment is accessible"""
    try:
        r = requests.get(
            f"{BASE_URL}/hls/{stream_id}/index{segment_num}.ts", timeout=10
        )
        stats["segment_requests"] += 1
        if r.status_code == 200:
            stats["segment_success"] += 1
            return True
        else:
            stats["segment_404"] += 1
            return False
    except:
        stats["segment_requests"] += 1
        stats["segment_404"] += 1
        return False


def simulate_playback(stream_id, start_pos, duration=10):
    """Simulate player requesting segments during playback"""
    start_seg = start_pos // 4
    num_segs = duration // 4

    success = 0
    for i in range(num_segs):
        if check_segment(stream_id, start_seg + i):
            success += 1
        time.sleep(0.5)  # Simulate real playback timing

    return success, num_segs


def stress_test_sequential():
    """Test: Sequential seeks (forward, backward, random)"""
    log("\n" + "=" * 60, Colors.CYAN)
    log("STRESS TEST: Sequential Seeks", Colors.CYAN)
    log("=" * 60, Colors.CYAN)

    stream_id = create_stream()
    if not stream_id:
        log("Failed to create stream!", Colors.RED)
        return False

    log(f"Stream: {stream_id}", Colors.GREEN)
    time.sleep(3)

    # Test scenarios
    seek_positions = [
        ("Start", 0),
        ("5 min", 300),
        ("15 min", 900),
        ("30 min", 1800),
        ("45 min", 2700),
        ("Back to 20 min", 1200),
        ("Back to 10 min", 600),
        ("Jump to 40 min", 2400),
        ("Near end (50 min)", 3000),
        ("Back to start", 60),
    ]

    results = []
    for name, pos in seek_positions:
        log(f"\n[SEEK] {name} ({pos}s / {pos // 60} min)...", Colors.YELLOW)

        success, elapsed = seek_to(stream_id, pos)

        if success:
            log(f"  Seek OK in {elapsed:.1f}s", Colors.GREEN)

            # Verify segments exist
            time.sleep(2)
            seg_num = pos // 4
            if check_segment(stream_id, seg_num):
                log(f"  Segment {seg_num} accessible", Colors.GREEN)
                results.append(True)
            else:
                log(f"  Segment {seg_num} NOT accessible!", Colors.RED)
                results.append(False)
        else:
            log(f"  Seek FAILED after {elapsed:.1f}s", Colors.RED)
            results.append(False)

    return all(results)


def stress_test_rapid():
    """Test: Rapid seeks (user clicking fast)"""
    log("\n" + "=" * 60, Colors.CYAN)
    log("STRESS TEST: Rapid Seeks (impatient user)", Colors.CYAN)
    log("=" * 60, Colors.CYAN)

    stream_id = create_stream()
    if not stream_id:
        log("Failed to create stream!", Colors.RED)
        return False

    log(f"Stream: {stream_id}", Colors.GREEN)
    time.sleep(3)

    # Rapid random seeks
    positions = [random.randint(60, VIDEO_DURATION - 60) for _ in range(5)]

    log(f"\nRapid seeks to: {[f'{p // 60}m' for p in positions]}", Colors.YELLOW)

    for i, pos in enumerate(positions):
        log(f"\n[{i + 1}/5] Seek to {pos}s...", Colors.YELLOW)
        success, elapsed = seek_to(stream_id, pos)

        if success:
            log(f"  OK ({elapsed:.1f}s)", Colors.GREEN)
        else:
            log(f"  FAILED ({elapsed:.1f}s)", Colors.RED)

        # Short pause (impatient user)
        time.sleep(1)

    # Final check - verify last position works
    time.sleep(5)
    final_seg = positions[-1] // 4

    if check_segment(stream_id, final_seg):
        log(f"\nFinal segment {final_seg} accessible", Colors.GREEN)
        return True
    else:
        log(f"\nFinal segment {final_seg} NOT accessible!", Colors.RED)
        return False


def stress_test_playback():
    """Test: Seek + playback simulation"""
    log("\n" + "=" * 60, Colors.CYAN)
    log("STRESS TEST: Seek + Playback", Colors.CYAN)
    log("=" * 60, Colors.CYAN)

    stream_id = create_stream()
    if not stream_id:
        log("Failed to create stream!", Colors.RED)
        return False

    log(f"Stream: {stream_id}", Colors.GREEN)
    time.sleep(3)

    # Seek to middle
    pos = 1500  # 25 min
    log(f"\n[SEEK] To {pos}s (25 min)...", Colors.YELLOW)
    success, elapsed = seek_to(stream_id, pos)

    if not success:
        log("Seek failed!", Colors.RED)
        return False

    log(f"Seek OK in {elapsed:.1f}s", Colors.GREEN)

    # Wait for segments
    time.sleep(8)

    # Simulate 20 seconds of playback
    log("\n[PLAYBACK] Simulating 20s of playback...", Colors.YELLOW)
    success, total = simulate_playback(stream_id, pos, 20)

    log(
        f"Segments loaded: {success}/{total}",
        Colors.GREEN if success == total else Colors.YELLOW,
    )

    return success >= total - 1  # Allow 1 miss


def print_stats():
    """Print final statistics"""
    log("\n" + "=" * 60, Colors.CYAN)
    log("STATISTICS", Colors.CYAN)
    log("=" * 60, Colors.CYAN)

    log(f"\nSeeks:", Colors.BLUE)
    log(f"  Total: {stats['seeks']}")
    log(
        f"  Success: {stats['seek_success']} ({100 * stats['seek_success'] / max(1, stats['seeks']):.0f}%)"
    )
    log(f"  Failed: {stats['seek_failed']}")

    if stats["seek_times"]:
        avg_time = sum(stats["seek_times"]) / len(stats["seek_times"])
        max_time = max(stats["seek_times"])
        min_time = min(stats["seek_times"])
        log(f"  Avg time: {avg_time:.1f}s")
        log(f"  Min time: {min_time:.1f}s")
        log(f"  Max time: {max_time:.1f}s")

    log(f"\nSegments:", Colors.BLUE)
    log(f"  Requests: {stats['segment_requests']}")
    log(
        f"  Success: {stats['segment_success']} ({100 * stats['segment_success'] / max(1, stats['segment_requests']):.0f}%)"
    )
    log(f"  404: {stats['segment_404']}")


def cleanup():
    """Cleanup all ffmpeg processes"""
    os.system("pkill -9 -f 'ffmpeg.*local_' 2>/dev/null")


def main():
    print("=" * 60)
    print("HLS STRESS TEST SUITE")
    print("=" * 60)

    # Check server
    try:
        r = requests.get(f"{BASE_URL}/whoami", timeout=5)
        if r.status_code != 200:
            log("Server not running!", Colors.RED)
            return
    except:
        log("Cannot connect to server!", Colors.RED)
        return

    log("Server OK", Colors.GREEN)

    results = {}

    try:
        # Test 1: Sequential seeks
        results["sequential"] = stress_test_sequential()
        cleanup()
        time.sleep(2)

        # Test 2: Rapid seeks
        results["rapid"] = stress_test_rapid()
        cleanup()
        time.sleep(2)

        # Test 3: Playback
        results["playback"] = stress_test_playback()
        cleanup()

    except KeyboardInterrupt:
        log("\nInterrupted!", Colors.YELLOW)
    finally:
        cleanup()

    # Print stats
    print_stats()

    # Summary
    log("\n" + "=" * 60, Colors.CYAN)
    log("RESULTS", Colors.CYAN)
    log("=" * 60, Colors.CYAN)

    all_passed = True
    for test, passed in results.items():
        status = (
            f"{Colors.GREEN}PASS{Colors.END}"
            if passed
            else f"{Colors.RED}FAIL{Colors.END}"
        )
        print(f"  {test}: {status}")
        if not passed:
            all_passed = False

    if all_passed:
        log("\nALL TESTS PASSED!", Colors.GREEN)
    else:
        log("\nSOME TESTS FAILED!", Colors.RED)


if __name__ == "__main__":
    main()
