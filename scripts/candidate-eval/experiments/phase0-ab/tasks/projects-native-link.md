# Linking a native ChatGPT Project binds a chat to a project folder that no longer exists

A local project can be linked to a native ChatGPT Project by pasting the Project chat's URL
(`linkNativeProject(projectId, 'https://chatgpt.com/g/<native-project-id>/c/<conversation-id>')`
in `src/main/projects.ts`). When a recorded session already exists for that conversation, the
link also files that chat under the local project.

Steps to reproduce:

1. Add a local project for an approved folder.
2. Create a session for the ChatGPT conversation that the Project URL names.
3. Remove (or move) the project's folder on disk.
4. Link the project to the Project URL.

Expected: the link itself is saved (the returned project carries `nativeProjectId` and
`nativeEntryConversationId`), and the chat is NOT bound to the project, because its folder is
unavailable. Binding a chat to a project must be refused for a missing or moved folder exactly as
it is everywhere else, and a chat that cannot join must never make the link itself fail.

Actual: the session ends up with `projectId` set to the project whose folder is gone.
