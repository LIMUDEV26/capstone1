declare module "*.css";
declare module "*.scss";
declare module "*.sass";
declare module "*.less";
declare module "sweetalert2/dist/sweetalert2.min.css";

interface Window {
  capstoneDesktop?: {
    isDesktop: boolean;
    platform: string;
    openExternal: (url: string) => Promise<boolean>;
    chooseBackupFolder: () => Promise<{ canceled: boolean; path: string }>;
  };
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}
