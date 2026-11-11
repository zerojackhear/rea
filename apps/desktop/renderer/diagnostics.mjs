export function toolDiagnostic(result) {
  if (result?.isError !== true) return null;
  let value = result.structuredContent;
  if (
    !value?.error &&
    result.content?.length === 1 &&
    result.content[0]?.type === "text"
  ) {
    try {
      value = JSON.parse(result.content[0].text);
    } catch {
      return null;
    }
  }
  const error = value?.error;
  if (!error || typeof error.message !== "string") return null;
  return {
    code: typeof error.code === "string" ? error.code : "",
    message: error.message,
    action:
      typeof error.remediation?.action === "string"
        ? error.remediation.action
        : "",
    reasons: Array.isArray(error.details?.rejections)
      ? error.details.rejections
          .filter((item) => typeof item?.reason === "string")
          .map(
            (item) =>
              (typeof item.provider_id === "string"
                ? item.provider_id + ": "
                : "") + item.reason,
          )
      : [],
  };
}
