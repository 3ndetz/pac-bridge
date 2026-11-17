import json
import os
import sys
import time

with open(os.environ['PAC_TEST_PID_FILE'], 'w', encoding='utf-8') as file:
    file.write(str(os.getpid()))

epoch = 'e8b00b0c-1f7c-40ce-80c8-b3f7d3313720'
tasks = [{'task_id': 'task', 'task_type': 'agent', 'description': 'working'}]
prompts = 0

def send(value):
    os.write(1, (json.dumps(value) + '\n').encode())

def close_owned_stdout():
    os.close(1)

for line in sys.stdin:
    message = json.loads(line)
    if 'id' not in message:
        continue
    method = message['method']
    response = None
    if method == 'initialize':
        response = {'protocolVersion': 1}
    elif method == 'session/new':
        response = {'sessionId': 'root', 'configOptions': [{'id': 'model', 'category': 'model', 'options': [{'value': 'PAC_test/sonnet'}]}]}
    elif method == 'session/set_config_option':
        response = {'configOptions': [{'id': 'model', 'currentValue': message['params']['value']}]}
    elif method == 'pac/background_tasks/snapshot':
        response = {'rootSessionId': 'root', 'epoch': epoch, 'availability': 'ready', 'tasks': tasks}
    elif method == 'session/prompt':
        prompts += 1
        if prompts > 1 or os.environ.get('PAC_TEST_BEFORE_EPOCH') == '1':
            send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'stopReason': 'end_turn'}})
            close_owned_stdout()
            while True:
                time.sleep(1)
        send({'jsonrpc': '2.0', 'method': 'pac/background_availability', 'params': {'rootSessionId': 'root', 'epoch': epoch, 'availability': 'ready', 'tasks': tasks}})
        response = {'stopReason': 'end_turn'}
    if response is not None:
        send({'jsonrpc': '2.0', 'id': message['id'], 'result': response})
