import os, subprocess, sys

subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=None, start_new_session=True, close_fds=True)
os._exit(0)
