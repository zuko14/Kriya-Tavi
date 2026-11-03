#!/usr/bin/env bash
# kriya-node host capability probe (SELF_HOSTED_OPERATIONS_RUNBOOK §2 step 1,
# spec §15). Read-only: it changes nothing, installs nothing, prints no
# secret. Run it on a candidate VPS and paste the output into status.md.
#
#   bash cloud-node/probe-host.sh
set -u

section() { printf '\n## %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "machine"
echo "kernel: $(uname -srm)"
[ -r /etc/os-release ] && . /etc/os-release && echo "os: ${PRETTY_NAME:-unknown}"
echo "cpus: $(nproc 2>/dev/null)"
grep -m1 'model name' /proc/cpuinfo 2>/dev/null | sed 's/^/cpu: /'
grep -E 'MemTotal|MemAvailable|SwapTotal' /proc/meminfo 2>/dev/null
have systemd-detect-virt && echo "virtualization: $(systemd-detect-virt 2>/dev/null)"

section "disk"
df -hT / /var/lib/docker 2>/dev/null | sort -u
df -i / 2>/dev/null | tail -1 | awk '{print "inodes free on /: " $4}'
findmnt -no FSTYPE,OPTIONS /var/lib/docker 2>/dev/null | sed 's/^/docker data mount: /' \
  || findmnt -no FSTYPE,OPTIONS / | sed 's/^/root mount: /'

section "cgroups"
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  echo "cgroup: v2"
  echo "controllers: $(cat /sys/fs/cgroup/cgroup.controllers)"
else
  echo "cgroup: v1 or hybrid (kriya-node requires v2)"
fi
for f in cpu memory io; do
  [ -r "/proc/pressure/$f" ] && echo "psi $f: $(head -1 /proc/pressure/$f)" || echo "psi $f: unavailable"
done

section "namespaces and confinement"
echo "user namespaces max: $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unknown)"
echo "unprivileged userns clone: $(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a)"
grep -q seccomp /proc/self/status && grep Seccomp /proc/self/status | head -1
if [ -r /sys/module/apparmor/parameters/enabled ]; then
  echo "apparmor: $(cat /sys/module/apparmor/parameters/enabled)"
else
  echo "apparmor: not loaded"
fi
have getenforce && echo "selinux: $(getenforce)"
echo "pid_max: $(cat /proc/sys/kernel/pid_max)"

section "virtualization for microVMs (Firecracker/Kata)"
if [ -e /dev/kvm ]; then ls -l /dev/kvm; else echo "/dev/kvm: absent (no Firecracker/Kata; gVisor systrap only)"; fi
grep -Eoc '(vmx|svm)' /proc/cpuinfo 2>/dev/null | sed 's/^/cpu virt flags: /'

section "container runtime"
if have docker; then
  docker version --format 'docker: server {{.Server.Version}}' 2>/dev/null || echo "docker: client only or daemon down"
  docker info --format 'storage driver: {{.Driver}}; runtimes: {{range $k, $v := .Runtimes}}{{$k}} {{end}}; cgroup driver: {{.CgroupDriver}}' 2>/dev/null
else
  echo "docker: not installed"
fi
if have runsc; then runsc --version 2>/dev/null | head -2; else echo "runsc: not installed"; fi

section "network"
have iptables && iptables --version
have nft && echo "nft: $(nft --version 2>/dev/null)"
echo "ipv6 disabled (all): $(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo n/a)"
ip -brief addr 2>/dev/null | awk '{print "if: " $1 " " $3}'
echo "metadata 169.254.169.254 reachable from host: $(timeout 2 bash -c '</dev/tcp/169.254.169.254/80' 2>/dev/null && echo yes || echo no)"
