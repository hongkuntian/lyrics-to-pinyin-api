// Evaluation-only branch: prohibit the normal database/migration/content preflight.
// Never merge this guard or this branch configuration into normal main.
throw new Error('evaluation_branch_forbids_normal_preflight');
