"""Version-gated Antigravity CLI history preview and provider-owned picker deletion.

This module is concatenated into the ephemeral SSH helper. It never edits the
provider's databases or worktrees directly.
"""

from urllib.parse import unquote, urlsplit
from contextlib import closing


class AntigravityUncertain(Exception):
    """The confirmation was sent, but provider deletion was not verified."""


def antigravity_snapshot(session_id):
    if str(uuid.UUID(session_id)) != session_id:
        raise ValueError("Antigravity cleanup requires a canonical UUID")
    version = run(["agy", "--version"], timeout=5)
    if version.returncode != 0 or version.stdout.strip() != "1.4.4":
        raise ValueError("Antigravity CLI 1.4.4 is required for verified picker deletion")
    root = HOME / ".gemini" / "antigravity-cli"
    trajectory = root / "conversations" / (session_id + ".db")
    brain = root / "brain" / session_id
    summary = root / "conversation_summaries.db"
    legacy = HOME / ".gemini" / "antigravity" / "conversations" / (session_id + ".pb")
    if legacy.exists() or legacy.is_symlink():
        raise ValueError("Legacy or duplicate Antigravity history has no verified deletion contract")
    if not summary.exists():
        if trajectory.exists() or brain.exists():
            raise ValueError("Antigravity summary index is missing while sidecars remain")
        return [], {}, None, []
    cleanup_file(summary)
    with closing(sqlite3.connect(f"file:{summary}?mode=ro", uri=True, timeout=2)) as conn:
        conn.row_factory = sqlite3.Row
        columns = {entry[1] for entry in conn.execute("PRAGMA table_info(conversation_summaries)")}
        required = {"conversation_id", "title", "step_count", "workspace_uris", "parent_conversation_id",
                    "nesting_depth", "battle_id", "winning_conversation_id", "group_id", "not_fully_idle"}
        if not required.issubset(columns):
            raise ValueError("Unsupported Antigravity summary schema")
        item = conn.execute("SELECT title, step_count, workspace_uris, parent_conversation_id, nesting_depth, "
                            "battle_id, winning_conversation_id, group_id, not_fully_idle "
                            "FROM conversation_summaries WHERE conversation_id = ?", (session_id,)).fetchone()
        referenced = conn.execute("SELECT 1 FROM conversation_summaries WHERE parent_conversation_id = ? "
                                  "OR winning_conversation_id = ? OR group_id = ? LIMIT 1",
                                  (session_id, session_id, session_id)).fetchone()
    if item is None:
        if trajectory.exists() or brain.exists():
            raise ValueError("Trajectory or brain data remains without a picker summary")
        return [], {}, None, []
    if not trajectory.exists() or trajectory.is_symlink():
        raise ValueError("Antigravity trajectory is missing or linked while its summary remains")
    if referenced or any(item[key] for key in ("parent_conversation_id", "nesting_depth", "battle_id", "winning_conversation_id", "group_id", "not_fully_idle")):
        raise ValueError("Related, grouped, or active Antigravity conversations require review")
    if not isinstance(item["step_count"], int) or item["step_count"] < 0 or not isinstance(item["title"], str):
        raise ValueError("Unsupported Antigravity picker identity metadata")
    try:
        workspaces = json.loads(item["workspace_uris"] or "[]")
    except (TypeError, ValueError):
        raise ValueError("Unsupported Antigravity workspace references")
    if not isinstance(workspaces, list) or not workspaces or len(workspaces) > 8 or any(not isinstance(uri, str) for uri in workspaces):
        raise ValueError("Unsupported Antigravity workspace references")
    for uri in workspaces:
        parsed = urlsplit(uri)
        if parsed.scheme != "file" or parsed.netloc not in ("", "localhost") or parsed.query or parsed.fragment:
            raise ValueError("Unsupported Antigravity workspace location")
        workspace = Path(unquote(parsed.path))
        if not workspace.is_absolute() or not workspace.is_dir() or ".system_generated" in workspace.parts or ".system_generated" in workspace.resolve().parts:
            raise ValueError("Provider-managed internal worktree requires separate review")
        if any((workspace / relative).exists() for relative in (".system_generated/worktrees", ".gemini/.system_generated/worktrees")):
            raise ValueError("Provider-managed internal worktree requires separate review")
    cleanup_file(trajectory)
    with trajectory.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\0":
            raise ValueError("Unsupported Antigravity trajectory format")
    with closing(sqlite3.connect(f"file:{trajectory}?mode=ro", uri=True, timeout=2)) as conn:
        tables = {entry[0] for entry in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if not {"trajectory_meta", "steps", "parent_references", "battle_mode_infos"}.issubset(tables):
            raise ValueError("Unsupported Antigravity trajectory schema")
        if conn.execute("SELECT 1 FROM parent_references LIMIT 1").fetchone() or conn.execute("SELECT 1 FROM battle_mode_infos LIMIT 1").fetchone():
            raise ValueError("Related Antigravity trajectory requires review")
    for suffix in ("-wal", "-shm"):
        sidecar = trajectory.with_name(trajectory.name + suffix)
        if sidecar.is_symlink():
            raise ValueError("Linked Antigravity SQLite sidecar is unsupported")
        if sidecar.exists() and (sidecar.stat().st_uid != os.getuid() or not stat.S_ISREG(sidecar.stat().st_mode)):
            raise ValueError("Unowned Antigravity SQLite sidecar is unsupported")
    # SQLite can recreate WAL/SHM while the picker reads its history. They are
    # provider-owned sidecars, but unsuitable as stable review fingerprints.
    files = [trajectory] + cleanup_tree(brain)
    # The picker owns its shared index and any provider-managed sidecars. The
    # row digest only detects changes; it is never used to write SQLite data.
    metadata = [item[key] for key in ("title", "step_count", "workspace_uris", "parent_conversation_id",
                                     "nesting_depth", "battle_id", "winning_conversation_id", "group_id", "not_fully_idle")]
    digest = hashlib.sha256(json.dumps(metadata, ensure_ascii=False).encode()).hexdigest()
    return files, {}, trajectory, [session_id, item["title"], item["step_count"], digest]


def antigravity_absent(session_id):
    root = HOME / ".gemini" / "antigravity-cli"
    trajectory = root / "conversations" / (session_id + ".db")
    if any(path.exists() or path.is_symlink() for path in (trajectory, trajectory.with_name(trajectory.name + "-wal"),
                                                          trajectory.with_name(trajectory.name + "-shm"), root / "brain" / session_id)):
        return False
    summary = root / "conversation_summaries.db"
    if not summary.exists():
        return True
    with closing(sqlite3.connect(f"file:{summary}?mode=ro", uri=True, timeout=2)) as conn:
        return conn.execute("SELECT 1 FROM conversation_summaries WHERE conversation_id = ?", (session_id,)).fetchone() is None


class AntigravityPicker:
    def __init__(self, deadline):
        self.deadline = deadline
        self.socket = "agentc2-history-" + uuid.uuid4().hex[:16]
        self.directory = Path(tempfile.mkdtemp(prefix="agentc2-agy-picker-"))
        self.pid = None
        self.usable = False
        try:
            binary = shutil.which("agy")
            if not binary:
                raise ValueError("Antigravity CLI is unavailable")
            started = run(["tmux", "-L", self.socket, "new-session", "-d", "-s", "picker", "-x", "160", "-y", "40",
                           "-c", str(self.directory), "exec " + shlex.quote(binary)], timeout=4)
            if started.returncode != 0:
                raise ValueError("Could not start the Antigravity history picker")
            self.pid = int(self.command("display-message", "-p", "-t", "picker", "#{pane_pid}").stdout.strip())
            limit = min(deadline, time.monotonic() + 15)
            while time.monotonic() < limit:
                screen = self.screen()
                if "Do you trust the contents of this project?" in screen:
                    if "Yes, I trust this folder" not in screen:
                        raise ValueError("Unrecognized Antigravity trust prompt")
                    self.keys("Enter")
                elif any(line.startswith(">") for line in screen.splitlines()) and "Type to search conversations" not in screen:
                    break
                time.sleep(0.15)
            else:
                raise ValueError("Antigravity picker did not reach its prompt")
            self.keys("-l", "/resume")
            self.keys("Enter")
            self.wait_for(lambda screen: "Type to search conversations" in screen and "f4 Delete" in screen,
                          "Antigravity conversation picker did not open", 10)
            self.usable = True
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self.close()
            raise

    def command(self, *args):
        try:
            result = run(["tmux", "-L", self.socket, *args], timeout=3)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError("Antigravity picker became unavailable") from error
        if result.returncode != 0:
            raise ValueError("Antigravity picker became unavailable")
        return result

    def screen(self):
        return self.command("capture-pane", "-p", "-t", "picker").stdout

    def keys(self, *keys):
        self.command("send-keys", "-t", "picker", *keys)

    def wait_for(self, predicate, message, seconds):
        limit = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < limit:
            screen = self.screen()
            if predicate(screen):
                return screen
            time.sleep(0.15)
        raise ValueError(message)

    def delete(self, session_id, title, steps):
        if not self.usable or time.monotonic() > self.deadline - 8:
            raise ValueError("Antigravity picker or batch time limit is unavailable")
        self.wait_for(lambda screen: "Type to search conversations" in screen and "f4 Delete" in screen,
                      "Antigravity picker search was not clear", 3)
        self.keys("-l", session_id)
        def selected(screen, confirming=False):
            if f"Search: {session_id}" not in screen or "f4 Delete" not in screen:
                return False
            rows = [line for line in screen.splitlines() if line.startswith("> ")]
            if len(rows) != 1 or not re.search(rf"\b{steps} steps?\b", rows[0]):
                return False
            if title and title[:40] not in rows[0]:
                return False
            return "[Delete? (y/n)]" in rows[0] if confirming else "[Delete? (y/n)]" not in rows[0]
        self.wait_for(selected, "Exact Antigravity conversation could not be verified in the picker", 6)
        self.keys("F4")
        self.wait_for(lambda screen: selected(screen, True), "Antigravity deletion confirmation did not match", 4)
        if time.monotonic() > self.deadline - 5:
            raise ValueError("Antigravity batch time limit reached before confirmation")
        try:
            self.keys("y")
        except (OSError, ValueError) as error:
            self.usable = False
            raise AntigravityUncertain("Antigravity confirmation outcome is unknown") from error
        limit = min(self.deadline, time.monotonic() + 12)
        while time.monotonic() < limit:
            try:
                if antigravity_absent(session_id):
                    break
            except (OSError, sqlite3.Error):
                pass
            time.sleep(0.2)
        else:
            self.usable = False
            raise AntigravityUncertain("Antigravity did not confirm removal; preview again")
        try:
            self.keys("Escape")
            self.wait_for(lambda screen: "Type to search conversations" in screen and "f4 Delete" in screen,
                          "Antigravity picker could not clear its search", 3)
        except (OSError, ValueError):
            self.usable = False

    def close(self):
        try:
            run(["tmux", "-L", self.socket, "kill-server"], timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            shutil.rmtree(self.directory, ignore_errors=True)
