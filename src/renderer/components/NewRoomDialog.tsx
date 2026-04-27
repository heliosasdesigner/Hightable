import { useState, type FormEvent, type ReactElement } from "react";
import type { HightableRoom } from "../../shared/types";

export interface NewRoomDialogProps {
  onClose: () => void;
  onCreated: (room: HightableRoom) => void;
}

export function NewRoomDialog({ onClose, onCreated }: NewRoomDialogProps): ReactElement {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function pickPath(): Promise<void> {
    try {
      const result = await window.hightable.pickDirectory();
      if (!result.canceled && result.path) {
        setRepoPath(result.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const room = await window.hightable.createRoom({
        name: name.trim(),
        repoPath: repoPath.trim(),
        topic: topic.trim() || undefined,
      });
      onCreated(room);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-room-title">
      <form className="dialog" onSubmit={submit}>
        <header className="dialog-header">
          <h2 id="new-room-title">New Room</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </header>

        <label className="dialog-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Auth refactor review"
            autoFocus
            required
          />
        </label>

        <label className="dialog-field">
          <span>Repo path</span>
          <div className="dialog-path-row">
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/you/path/to/repo"
              required
            />
            <button type="button" className="btn-ghost" onClick={() => void pickPath()}>
              Pick…
            </button>
          </div>
        </label>

        <label className="dialog-field">
          <span>Topic (optional)</span>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Review router and onboarding flow"
          />
        </label>

        {error ? <p className="dialog-error">{error}</p> : null}

        <footer className="dialog-footer">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
