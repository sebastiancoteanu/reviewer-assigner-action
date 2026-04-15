export interface ReviewerAssignmentConfig {
	reviewer_count: number;
	lookback_days: number;
	exclude_users: string[];
	exclude_bots: boolean;
	dry_run: boolean;
	skip_if_reviewers_already_assigned: boolean;
	skip_generated_files: boolean;
	leave_comment: boolean;
}

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface PullRequestContext {
	owner: string;
	repo: string;
	number: number;
	author: string;
	requestedReviewers: string[];
}

export interface ActionContext {
	octokit: any;
	owner: string;
	repo: string;
	config: ReviewerAssignmentConfig;
	logger: Logger;
	candidateCoverage: Map<string, number>;
	fileDetails: Map<string, unknown>;
	codeownersResolver: {
		getCodeOwnersForFile(filePath: string): Promise<string[]>;
	};
	openPullRequests?: any[];
	historicalFileReviewCounts: Map<string, number>;
}

export interface ScoredReviewer {
	user: string;
	score: number;
	metrics: {
		activeReviews: number;
		avgPrSize: number;
		fileReviewCount: number;
	};
}
