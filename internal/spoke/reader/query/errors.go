package query

// 错误码，随结果返回给中心。
const (
	CodeUndeclared   = "undeclared_template"
	CodeHashMismatch = "content_hash_mismatch"
	CodeBadParams    = "bad_params"
	CodeBadRange     = "bad_range"
	CodeTooLarge     = "response_too_large"
	CodeTimeout      = "timeout"
	CodeOverloaded   = "concurrency_limit"
	CodeBreakerOpen  = "breaker_open"
	CodeBackend      = "backend_error"
	CodeUnknownDS    = "unknown_datasource"
)

// Error 是带错误码的查询错误。
type Error struct {
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }
