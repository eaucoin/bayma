package session

// The host's own first cell: what cells checkpoint and show images with. Its
// names reach them as any earlier cell's do.
const preludeSource = `import (
	"encoding/json"
	"errors"
	"os"
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

var bayma_images [][]byte

// bayma_display_image shows the model image, the bytes of a PNG, JPEG, GIF,
// or WebP file, when the cell ends.
func bayma_display_image(image []byte) {
	bayma_images = append(bayma_images, append([]byte(nil), image...))
}

// bayma_display_image_file shows the model the image in the file at path.
func bayma_display_image_file(path string) error {
	image, err := os.ReadFile(path)
	if err == nil {
		bayma_display_image(image)
	}
	return err
}
`

// What the prelude's plugin gives the host.
const preludeExports = `func Checkpoint() []byte { return cell.Bayma_bayma_checkpoint }

func SetCheckpoint(data []byte) { cell.Bayma_bayma_checkpoint = data }

func TakeImages() [][]byte {
	images := cell.Bayma_bayma_images
	cell.Bayma_bayma_images = nil
	return images
}
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

// TakeImages returns the images cells showed since it was last called.
func (s *Session) TakeImages() [][]byte {
	takeImages, _ := s.prelude.Lookup("TakeImages")
	return takeImages.(func() [][]byte)()
}
