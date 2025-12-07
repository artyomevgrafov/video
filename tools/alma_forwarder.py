#!/usr/bin/env python3
"""
alma_forwarder.py — simple HTTP forwarder to control TV from Alma

This small flask app exposes an endpoint to open a URL on a device via DIAL.
It is intended to be run locally on Alma and to forward requests to TV.

Usage (example):
  python3 alma_forwarder.py --host 0.0.0.0 --port 8081
  POST http://localhost:8081/open  JSON: {"tv_ip":"192.168.100.11","app":"Browser","url":"http://example.com"}

"""
import argparse
import time
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)
REQUEST_TIMEOUT = 5


def start_app_and_open(tv_ip, app_name, url_to_open, tv_port=3367):
    base = f'http://{tv_ip}:{tv_port}'
    start_url = f'{base}/apps/{app_name}'
    headers = {'User-Agent':'DIAL/2.1', 'Content-Type':'text/plain'}
    # start app (empty or simple)
    r = requests.post(start_url, headers={'User-Agent':'DIAL/2.1', 'Content-Length':'0'}, timeout=REQUEST_TIMEOUT)
    if r.status_code in (200,201):
        location = r.headers.get('Location')
        if location:
            # post URL to run resource
            rr = requests.post(location, data=url_to_open, headers={'Content-Type':'text/plain', 'User-Agent':'DIAL/2.1'}, timeout=REQUEST_TIMEOUT)
            # optional: return state and rr.status
            return {'start_status': r.status_code, 'run_status': rr.status_code, 'location': location}
        else:
            return {'start_status': r.status_code, 'message': 'No location header'}
    else:
        return {'start_status': r.status_code, 'message': 'Failed to start app'}


@app.route('/open', methods=['POST'])
def open_url():
    j = request.get_json() or {}
    tv_ip = j.get('tv_ip')
    app_name = j.get('app', 'Browser')
    url_to_open = j.get('url')
    tv_port = j.get('port', 3367)
    if not tv_ip:
        return jsonify({'error': 'tv_ip required'}), 400
    try:
        res = start_app_and_open(tv_ip, app_name, url_to_open, tv_port)
        return jsonify(res)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8081)
    args = parser.parse_args()
    app.run(host=args.host, port=args.port)


if __name__ == '__main__':
    main()
