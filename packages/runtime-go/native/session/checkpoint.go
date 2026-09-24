package session

// The host's own first cell: what cells checkpoint with. Its names reach them
// as any earlier cell's do.
const preludeSource = `import (
	"encoding/json"
	"errors"
)

var bayma_checkpoint json.RawMessage

// bayma_write_checkpoint keeps value, as JSON, for the session to recover.
func bayma_write_checkpoint(value any) error {
	data, err := json.Marshal(value)
	if err == nil {
		bayma_checkpoint = data
	}
	return err
}

// bayma_read_checkpoint decodes the session's checkpoint into into.
func bayma_read_checkpoint(into any) error {
	if bayma_checkpoint == nil {
		return errors.New("the session has no checkpoint")
	}
	return json.Unmarshal(bayma_checkpoint, into)
}
`

// What the prelude's plugin gives the host.
const preludeExports = `func Checkpoint() []byte { return cell.Bayma_bayma_checkpoint }

func SetCheckpoint(data []byte) { cell.Bayma_bayma_checkpoint = data }
`

// Checkpoint is the JSON the session's cells last wrote, or nil.
func (s *Session) Checkpoint() []byte {
	checkpoint, _ := s.prelude.Lookup("Checkpoint")
	return checkpoint.(func() []byte)()
}

// SetCheckpoint makes data the checkpoint cells read.
func (s *Session) SetCheckpoint(data []byte) {
	setCheckpoint, _ := s.prelude.Lookup("SetCheckpoint")
	setCheckpoint.(func([]byte))(data)
}
