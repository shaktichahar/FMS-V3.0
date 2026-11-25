import fs from 'node:fs';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let projectId: string | undefined =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined;

try {
  const firebaseConfig = JSON.parse(
    fs.readFileSync(new URL('../../firebase-applet-config.json', import.meta.url), 'utf8')
  ) as { projectId?: string };
  if (firebaseConfig.projectId) {
    projectId = firebaseConfig.projectId;
  }
} catch {
  // Fall back to ambient GCP project metadata on Cloud Run
}

if (!getApps().length) {
  initializeApp(projectId ? { projectId } : undefined);
}

export const adminAuth = getAuth();
