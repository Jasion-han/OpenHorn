# Library folders

Add a single level of folders in personal and project libraries. A folder can be empty, and every version of a document shares its folder. Browse and search can combine folder, tag, and favorite filters. Deleting a folder sends its contents to Uncategorized.

1. [x] Add the folder table and nullable document relation in Drizzle and startup migration. Implement scoped create, rename, delete, and document assignment using the existing Library transaction and revision checks.
2. [x] Add the folder picker, folder management, and document placement to the Library interface. Use the selected folder as the destination for new documents.
3. [x] Round-trip folders and document references in backups, including empty folders and legacy archives. Verify scope isolation, folder removal, version inheritance, and the browser controls.
