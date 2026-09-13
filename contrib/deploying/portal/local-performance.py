#!/usr/bin/env python3
"""Measure the synthetic local query HTTP path; never target a cloud endpoint."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import math
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--synthetic', action='store_true', required=True)
    parser.add_argument('--requests', type=int, default=100)
    parser.add_argument('--concurrency', type=int, default=4)
    args = parser.parse_args()
    target = urlparse(args.url)
    if (target.scheme != 'http' or target.hostname not in ('127.0.0.1', 'localhost')
            or not target.port or target.username or target.password
            or target.path != '/v1/query' or target.query or target.fragment):
        parser.error('Expected an explicit loopback HTTP test query endpoint')
    if not 1 <= args.requests <= 500 or not 1 <= args.concurrency <= 8:
        parser.error('Bounded requests (1–500) and concurrency (1–8) required')

    def query(_):
        body = json.dumps({'requestId': str(uuid.uuid4()), 'text': args.text,
                           'mode': 'locate', 'locale': 'en'}).encode()
        request = Request(args.url, data=body, headers={
            'content-type': 'application/json',
            'authorization': 'Bearer e2e-service',
            'x-portal-user-evidence': 'e2e-iap:bob',
            'x-portal-company-id': 'company-b',
        })
        started = time.perf_counter()
        try:
            with urlopen(request, timeout=15) as response:
                result = json.load(response)
                success = response.status == 200 and bool(result.get('evidence'))
        except (HTTPError, OSError, ValueError):
            success = False
        return {'ms': (time.perf_counter() - started) * 1000, 'success': success}

    first = query(0)
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        samples = list(executor.map(query, range(args.requests)))
    elapsed = time.perf_counter() - started
    durations = [sample['ms'] for sample in samples]
    errors = sum(not sample['success'] for sample in samples)
    print(json.dumps({
        'scope': 'local synthetic query HTTP; includes authentication fixture, PostgreSQL RLS and cache',
        'firstRequestMs': round(first['ms'], 3), 'firstRequestSucceeded': first['success'],
        'requests': args.requests, 'concurrency': args.concurrency, 'errors': errors,
        'p50Ms': round(percentile(durations, .5), 3),
        'p95Ms': round(percentile(durations, .95), 3),
        'p99Ms': round(percentile(durations, .99), 3),
        'requestsPerSecond': round(args.requests / elapsed, 3),
        'limitations': 'Small synthetic corpus; first request is not a proven cold cache; no Google or cloud-network latency.'
    }, indent=2))
    if errors or not first['success']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
