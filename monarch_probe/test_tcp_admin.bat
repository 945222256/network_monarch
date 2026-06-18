@echo off
cd /d "G:\Playground\network_monarch\monarch_probe"
ntrace --json -T -p 443 -d LeoMoeAPI 168.50.248.122 > test_trace_tcp.json
