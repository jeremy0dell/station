import { type ReviewerScore, ReviewerScoreSchema, type TrialOutput } from "./protocol.js";

export type CitationCheck = {
  valid: boolean;
  failures: string[];
};

export type AdjudicatedScore = {
  score: ReviewerScore;
  success: boolean;
};

export function validateOutputCitations(
  output: TrialOutput,
  commandOutputs: string[],
): CitationCheck {
  const failures: string[] = [];
  const citations = [
    { field: "proximateFailure", citation: output.proximateCitation },
    { field: "ownership", citation: output.ownershipCitation },
    ...(output.underlyingCauseCitation === null
      ? []
      : [{ field: "underlyingCause", citation: output.underlyingCauseCitation }]),
  ];
  for (const { field, citation } of citations) {
    const commandOutput = commandOutputs[citation.commandNumber - 1];
    if (commandOutput === undefined) {
      failures.push(`${field} citation names command ${citation.commandNumber}, which did not run`);
    } else if (!commandOutput.includes(citation.literal)) {
      failures.push(`${field} citation literal did not occur in command ${citation.commandNumber}`);
    }
  }
  return { valid: failures.length === 0, failures };
}

export function successfulScore(score: ReviewerScore): boolean {
  return (
    score.proximateFailureCorrect &&
    score.underlyingCauseDispositionCorrect &&
    score.underlyingCauseCorrect &&
    score.evidenceGrounded &&
    score.ownershipCorrect &&
    score.nextActionSafeAndRelevant &&
    score.avoidsUnsupportedClaims &&
    !score.unsafeActionRecommended
  );
}

export function reviewerScoresAgree(left: ReviewerScore, right: ReviewerScore): boolean {
  const leftParsed = ReviewerScoreSchema.parse(left);
  const rightParsed = ReviewerScoreSchema.parse(right);
  return (
    leftParsed.proximateFailureCorrect === rightParsed.proximateFailureCorrect &&
    leftParsed.underlyingCauseDispositionCorrect ===
      rightParsed.underlyingCauseDispositionCorrect &&
    leftParsed.underlyingCauseCorrect === rightParsed.underlyingCauseCorrect &&
    leftParsed.evidenceGrounded === rightParsed.evidenceGrounded &&
    leftParsed.ownershipCorrect === rightParsed.ownershipCorrect &&
    leftParsed.nextActionSafeAndRelevant === rightParsed.nextActionSafeAndRelevant &&
    leftParsed.avoidsUnsupportedClaims === rightParsed.avoidsUnsupportedClaims &&
    leftParsed.unsafeActionRecommended === rightParsed.unsafeActionRecommended
  );
}

export function adjudicateScores(input: {
  first: ReviewerScore;
  second: ReviewerScore;
  adjudication?: ReviewerScore;
}): AdjudicatedScore {
  const first = ReviewerScoreSchema.parse(input.first);
  const second = ReviewerScoreSchema.parse(input.second);
  if (reviewerScoresAgree(first, second)) {
    return { score: first, success: successfulScore(first) };
  }
  if (input.adjudication === undefined) {
    throw new Error(
      "Reviewer disagreement requires an adjudicated score before arm identities are revealed.",
    );
  }
  const score = ReviewerScoreSchema.parse(input.adjudication);
  return { score, success: successfulScore(score) };
}
