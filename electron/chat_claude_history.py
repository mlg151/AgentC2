import json,sys
from claude_agent_sdk import get_session_info,get_session_messages
identifier,directory=sys.argv[1:]
info=get_session_info(identifier,directory=directory)
print(json.dumps(None if info is None else [dict(uuid=m.uuid,type=m.type,message=m.message) for m in get_session_messages(identifier,directory=directory)]))
