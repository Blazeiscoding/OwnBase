import type { ID, ViewSubmitted } from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { answerOf } from "./answers.js";
import { ApiError, type Api } from "./api.js";
import type { WorkspaceState } from "./workspaceState.js";

/** The forms apps open for this person, a stack of them, shown top first. */
export class Modals {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  /** Takes forms off the stack; the one left on top, if any, is shown. */
  forgetModals(viewIds: readonly ID[]): void {
    const { modal, modalsBelow } = this.state;
    const open = [...modalsBelow, ...(modal ? [modal] : [])];
    const kept = open.filter((view) => !viewIds.includes(view.id));
    if (kept.length === open.length) return;
    this.store.setState({ modal: kept.at(-1) ?? null, modalsBelow: kept.slice(0, -1) });
  }

  dismissModal(viewId = this.state.modal?.id): void {
    if (!viewId || this.state.modal?.id !== viewId) return;
    this.forgetModals([viewId]);
    void this.api.closeView(viewId).catch(() => {});
  }

  dismissAllModals(): void {
    const { modal, modalsBelow } = this.state;
    const root = modalsBelow[0] ?? modal;
    if (!root) return;
    this.forgetModals([...modalsBelow, ...(modal ? [modal] : [])].map((view) => view.id));
    void this.api.closeView(root.id).catch(() => {});
  }

  async submitModal(
    values: Record<string, Record<string, string | string[]>>,
    viewId = this.state.modal?.id,
  ): Promise<ViewSubmitted | ApiError> {
    const modal = this.state.modal;
    if (!modal || modal.id !== viewId)
      return { ok: false, errors: {}, message: "This form is no longer available." };
    const result = await answerOf(() => this.api.submitView(modal.id, values));
    // The server names what closed: none when the app changed the form or
    // stacked another on it. Only ever closing keeps a late answer from
    // reopening one.
    if (!(result instanceof ApiError) && result.ok) this.forgetModals(result.closedViewIds);
    return result;
  }
}
