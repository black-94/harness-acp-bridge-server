#!/usr/bin/python3
"""Allow only established Aliyun DNS replies before Tailscale CGNAT anti-spoofing."""
import argparse
import fcntl
import json
import os
import shlex
import shutil
import subprocess

CHAIN = 'SAIL_CLOUD_DNS'
MARKER = 'sail-cloud-dns-replies'
IPTABLES = shutil.which('iptables') or '/usr/sbin/iptables'
RULES = [
    ['-i', 'eth0', '-s', address + '/32', '-p', protocol, '-m', protocol,
     '--sport', '53', '-m', 'conntrack', '--ctstate', 'ESTABLISHED',
     '-m', 'comment', '--comment', MARKER, '-j', 'ACCEPT']
    for address in ('100.100.2.136', '100.100.2.138')
    for protocol in ('udp', 'tcp')
]
RETURN = ['-j', 'RETURN']
JUMP = ['-m', 'comment', '--comment', MARKER, '-j', CHAIN]


def ipt(*arguments, check=True):
    return subprocess.run([IPTABLES, '-w', '5', '-t', 'filter', *arguments],
                          check=check, text=True, capture_output=True, timeout=15)


def exists(chain, rule):
    result = ipt('-C', chain, *rule, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return result.returncode == 0


def chain_rules(chain):
    return [shlex.split(line)[2:] for line in ipt('-S', chain).stdout.splitlines()
            if line.startswith('-A ' + chain + ' ')]


def verify():
    rules = chain_rules(CHAIN)
    if len(rules) != 5 or not all(exists(CHAIN, rule) for rule in RULES + [RETURN]):
        raise RuntimeError('Cloud DNS chain does not contain exactly the four narrow replies and RETURN')
    input_rules = chain_rules('INPUT')
    if not input_rules or input_rules[0] != JUMP or input_rules.count(JUMP) != 1:
        raise RuntimeError('Cloud DNS jump is not uniquely at INPUT position 1')
    return {'chain': CHAIN, 'input_position': 1, 'accept_rules': 4,
            'interface': 'eth0', 'sources': ['100.100.2.136/32', '100.100.2.138/32'],
            'protocols': ['udp', 'tcp'], 'source_port': 53,
            'conntrack_state': 'ESTABLISHED'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Verify without modifying firewall rules')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Root is required')
    if args.check:
        print(json.dumps(verify()))
        return
    with open('/run/lock/sail-cloud-dns.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ipt('-S', 'INPUT')
        result = ipt('-S', CHAIN, check=False)
        if result.returncode == 1:
            ipt('-N', CHAIN)
        elif result.returncode != 0:
            raise RuntimeError(result.stderr)
        existing = chain_rules(CHAIN)
        known_count = sum(exists(CHAIN, rule) for rule in RULES + [RETURN])
        if len(existing) != known_count:
            raise RuntimeError('Unexpected or duplicate rule in owned cloud DNS chain; refusing to alter it')
        changed = False
        for rule in RULES:
            if not exists(CHAIN, rule):
                ipt('-I', CHAIN, '1', *rule)
                changed = True
        if not exists(CHAIN, RETURN):
            ipt('-A', CHAIN, *RETURN)
            changed = True
        input_rules = chain_rules('INPUT')
        if not input_rules or input_rules[0] != JUMP or input_rules.count(JUMP) != 1:
            while exists('INPUT', JUMP):
                ipt('-D', 'INPUT', *JUMP)
            ipt('-I', 'INPUT', '1', *JUMP)
            changed = True
        state = verify()
        if changed:
            print(json.dumps({'changed': True, **state}))


if __name__ == '__main__':
    main()
