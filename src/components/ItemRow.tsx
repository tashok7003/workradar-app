import { nameOf } from "../lib/people";
import { ago } from "../lib/time";
import { useRouter } from "../router";
import type { Ranked } from "../types";
import { Avatar, ItemActions, ReasonChips, SourceBadge, StatusPill } from "./ui";

export function ItemRow({ r, showScore = false, compactActions = false }: { r: Ranked; showScore?: boolean; compactActions?: boolean }) {
  const { go } = useRouter();
  const { item } = r;
  const open = () => go({ name: "item", id: item.id });
  return (
    <article
      className={`row row-${r.tier}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); }}
      tabIndex={0}
      aria-label={`${item.key}: ${item.title}`}
    >
      <div className="row-main">
        <div className="row-meta">
          <SourceBadge source={item.source} />
          <span className="key">{item.key}</span>
          <StatusPill status={item.status} />
          <span className="row-time">{ago(item.updatedAt)}</span>
        </div>
        <h4 className="row-title">{item.title}</h4>
        <div className="row-foot">
          <span className="owner">
            <Avatar id={item.assignee ?? (item.needsReplyFromMe ? "me" : null)} size={20} />
            {item.assignee ? nameOf(item.assignee) : item.needsReplyFromMe ? "You" : "Unassigned"}
          </span>
          <ReasonChips reasons={r.reasons} />
        </div>
      </div>
      <div className="row-side">
        {showScore && <span className="score" title="Priority score">{r.score}</span>}
        <ItemActions item={item} compact={compactActions} />
      </div>
    </article>
  );
}
