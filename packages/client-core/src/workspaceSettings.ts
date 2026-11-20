import type {
  AccessPolicy,
  CreateUserGroupBody,
  CustomEmoji,
  ID,
  UpdateUserGroupBody,
  UserGroup,
} from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { answerOf, doneOf } from "./answers.js";
import type { Api, ApiError } from "./api.js";
import type { WorkspaceState } from "./workspaceState.js";

/**
 * What the workspace keeps for everyone in it: its name, who may join, link
 * previews, its icon, custom emoji and user groups. Each change shows here as
 * soon as the server keeps it, rather than when its event arrives.
 */
export class WorkspaceSettings {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly isStopped: () => boolean,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  private get stopped(): boolean {
    return this.isStopped();
  }

  renameWorkspace(name: string): Promise<string | ApiError> {
    return answerOf(async () => {
      const { workspaceName } = await this.api.renameWorkspace(name);
      if (!this.stopped) this.store.setState({ workspaceName });
      return workspaceName;
    });
  }

  setAccessPolicy(policy: AccessPolicy): Promise<ApiError | null> {
    return doneOf(async () => {
      const { accessPolicy } = await this.api.setAccessPolicy(policy);
      if (!this.stopped) this.store.setState({ accessPolicy });
    });
  }

  setLinkPreviews(enabled: boolean): Promise<ApiError | null> {
    return doneOf(async () => {
      const answer = await this.api.setLinkPreviews(enabled);
      if (!this.stopped) this.store.setState({ linkPreviews: answer.enabled });
    });
  }

  setWorkspaceIcon(image: Blob): Promise<ApiError | null> {
    return doneOf(async () => {
      const { iconVersion } = await this.api.setWorkspaceIcon(image);
      if (!this.stopped) this.store.setState({ iconVersion });
    });
  }

  addCustomEmoji(name: string, image: Blob): Promise<CustomEmoji | ApiError> {
    return answerOf(async () => {
      const { emoji } = await this.api.addCustomEmoji(name, image);
      this.keepEmoji(emoji);
      return emoji;
    });
  }

  removeCustomEmoji(emoji: CustomEmoji): Promise<ApiError | null> {
    return doneOf(async () => {
      await this.api.removeCustomEmoji(emoji.id);
      this.forgetEmoji(emoji.id, emoji.name);
    });
  }

  setEmojiAdding(adminsOnly: boolean): Promise<ApiError | null> {
    return doneOf(async () => {
      const answer = await this.api.setEmojiAdding(adminsOnly);
      if (!this.stopped) this.store.setState({ emojiAddingAdminsOnly: answer.adminsOnly });
    });
  }

  keepEmoji(emoji: CustomEmoji): void {
    if (this.stopped) return;
    const known = this.state.customEmoji;
    if (known[emoji.name]?.id === emoji.id) return;
    this.store.setState({ customEmoji: { ...known, [emoji.name]: emoji } });
  }

  /** Forgets one, unless the name already belongs to a newer emoji. */
  forgetEmoji(id: ID, name: string): void {
    if (this.stopped) return;
    const known = this.state.customEmoji;
    if (known[name]?.id !== id) return;
    const { [name]: _gone, ...rest } = known;
    this.store.setState({ customEmoji: rest });
  }

  createUserGroup(body: CreateUserGroupBody): Promise<UserGroup | ApiError> {
    return answerOf(async () => {
      const { group } = await this.api.createUserGroup(body);
      this.keepGroup(group);
      return group;
    });
  }

  updateUserGroup(id: ID, body: UpdateUserGroupBody): Promise<UserGroup | ApiError> {
    return answerOf(async () => {
      const { group } = await this.api.updateUserGroup(id, body);
      this.keepGroup(group);
      return group;
    });
  }

  deleteUserGroup(id: ID): Promise<ApiError | null> {
    return doneOf(async () => {
      await this.api.deleteUserGroup(id);
      this.forgetGroup(id);
    });
  }

  keepGroup(group: UserGroup): void {
    if (this.stopped) return;
    this.store.setState({ userGroups: { ...this.state.userGroups, [group.id]: group } });
  }

  forgetGroup(id: ID): void {
    if (this.stopped || !(id in this.state.userGroups)) return;
    const { [id]: _gone, ...rest } = this.state.userGroups;
    this.store.setState({ userGroups: rest });
  }

  removeWorkspaceIcon(): Promise<ApiError | null> {
    return doneOf(async () => {
      await this.api.removeWorkspaceIcon();
      if (!this.stopped) this.store.setState({ iconVersion: null });
    });
  }
}
