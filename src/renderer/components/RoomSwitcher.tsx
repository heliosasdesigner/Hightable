import { type ReactElement } from "react";
import type { HightableRoom } from "../../shared/types";

export interface RoomSwitcherProps {
  rooms: HightableRoom[];
  activeRoomId: string | null;
  onSelect: (roomId: string) => void;
  onNewRoom: () => void;
}

/**
 * Bauhaus brand mark — three primary shapes (red circle, white square,
 * blue triangle) stacked next to the wordmark.
 */
function BrandMark(): ReactElement {
  return (
    <span className="wordmark-icon" aria-hidden="true">
      <span className="w-circle" />
      <span className="w-square" />
      <span className="w-triangle" />
    </span>
  );
}

export function RoomSwitcher({
  rooms,
  activeRoomId,
  onSelect,
  onNewRoom,
}: RoomSwitcherProps): ReactElement {
  return (
    <aside className="hs-sidebar" aria-label="Rooms">
      <div className="hs-brand">
        <BrandMark />
        <span className="wordmark-text">Hightable</span>
      </div>

      <button className="hs-new-room" type="button" onClick={onNewRoom}>
        + New Room
      </button>

      <p className="hs-section-label">Rooms</p>
      <nav className="hs-nav" aria-label="Main navigation">
        {rooms.length === 0 ? (
          <p className="hs-nav-empty">No rooms yet.</p>
        ) : (
          rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={`hs-nav-link${room.id === activeRoomId ? " active" : ""}`}
              aria-current={room.id === activeRoomId ? "page" : undefined}
              onClick={() => onSelect(room.id)}
              title={room.repoPath}
            >
              <span>{room.name}</span>
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}
