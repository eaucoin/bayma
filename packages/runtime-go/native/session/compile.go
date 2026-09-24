package session

import (
	"errors"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"bayma-go-host/cell"
)

var (
	undefinedName = regexp.MustCompile(`^undefined: (\w+)$`)
	unusedImport  = regexp.MustCompile(`^"([^"]+)" imported (?:as \w+ )?and not used$`)
	hiddenMember  = regexp.MustCompile(`(?:cannot refer to unexported (?:field|method)|has no field or method) (\w+)`)
	mangledName   = regexp.MustCompile(`(c\d{4}\.)?` + cell.Mangle)
)

// Demangle shows generated names as the user wrote them.
func Demangle(text string) string { return mangledName.ReplaceAllString(text, "") }

// compile type-checks a cell's package with Go's own checker, and edits it
// until it stands on its own: a name from an earlier cell becomes a reference
// into that cell's package, an import this cell makes only for later ones
// becomes a blank import, and each name this cell declares unexported is
// exported under the reserved prefix, so the cells after it reach it as in
// the one package a session appears to be.
func (s *Session) compile(c *cell.Cell, name string) (string, *types.Package, error) {
	asValue := true
	text := c.Source(name, asValue)
	for attempt := 0; attempt < 10; attempt++ {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, "cell.go", text, 0)
		if err != nil {
			return "", nil, err
		}
		var problems []types.Error
		info := &types.Info{Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}}
		config := types.Config{
			Importer: importer.ForCompiler(fset, "gc", s.lookup),
			Error:    func(err error) { problems = append(problems, err.(types.Error)) },
		}
		pkg, _ := config.Check(s.cellPath(name), fset, []*ast.File{file}, info)
		if len(problems) == 0 {
			return exportDeclarations(text, fset, file, pkg, info), pkg, nil
		}

		// Changes to the cell itself start its source over; the edits below
		// are then found again.
		regenerate := false
		var edits []edit
		imports := map[string]bool{}
		for _, problem := range problems {
			offset := fset.Position(problem.Pos).Offset
			if m := undefinedName.FindStringSubmatch(problem.Msg); m != nil {
				if b, ok := s.names[m[1]]; ok && b.ident == "" {
					imports[fmt.Sprintf("%s %q", m[1], b.path)] = true
				} else if ok {
					cellName := filepath.Base(b.path)
					imports[fmt.Sprintf("%s %q", cellName, b.path)] = true
					edits = append(edits, edit{offset, len(m[1]), cellName + "." + b.ident})
				}
			} else if m := hiddenMember.FindStringSubmatch(problem.Msg); m != nil &&
				!token.IsExported(m[1]) && !strings.HasPrefix(m[1], cell.Mangle) {
				edits = append(edits, edit{offset, len(m[1]), cell.Mangle + m[1]})
			} else if m := unusedImport.FindStringSubmatch(problem.Msg); m != nil {
				regenerate = c.BlankImport(m[1]) || regenerate
			} else if strings.Contains(problem.Msg, "used as value") && asValue {
				asValue, regenerate = false, true
			}
		}
		switch {
		case regenerate:
			text = c.Source(name, asValue)
		case len(edits) > 0 || len(imports) > 0:
			text = applyEdits(text, edits, imports)
		default:
			messages := make([]string, len(problems))
			for i, problem := range problems {
				messages[i] = Demangle(problem.Msg)
			}
			return "", nil, errors.New(strings.Join(messages, "\n"))
		}
	}
	return "", nil, errors.New("the cell did not settle into a package")
}

// exportDeclarations renames each unexported name the cell declares at
// package level, and each unexported field and method of its types, to its
// reserved exported form, along with every use of it in the cell. A renamed
// field without a tag is tagged `json:"-"`, so encoding/json leaves it out as
// it would the unexported field.
func exportDeclarations(text string, fset *token.FileSet, file *ast.File, pkg *types.Package, info *types.Info) string {
	renamed := map[types.Object]bool{}
	for ident, obj := range info.Defs {
		if obj == nil || obj.Pkg() != pkg || obj.Exported() || ident.Name == "_" ||
			ident.Name == "init" || strings.HasPrefix(ident.Name, cell.Mangle) {
			continue
		}
		switch o := obj.(type) {
		case *types.Var:
			if o.Embedded() || !o.IsField() && o.Parent() != pkg.Scope() {
				continue
			}
		case *types.Func:
			if o.Type().(*types.Signature).Recv() == nil && o.Parent() != pkg.Scope() {
				continue
			}
		default:
			if obj.Parent() != pkg.Scope() {
				continue
			}
		}
		renamed[obj] = true
	}
	var edits []edit
	rename := func(ident *ast.Ident) {
		edits = append(edits, edit{fset.Position(ident.Pos()).Offset, len(ident.Name), cell.Mangle + ident.Name})
	}
	for ident, obj := range info.Defs {
		if renamed[obj] {
			rename(ident)
		}
	}
	for ident, obj := range info.Uses {
		if renamed[obj] {
			rename(ident)
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		if field, ok := n.(*ast.Field); ok && field.Tag == nil && len(field.Names) > 0 && renamed[info.Defs[field.Names[0]]] {
			edits = append(edits, edit{fset.Position(field.End()).Offset, 0, " `json:\"-\"`"})
		}
		return true
	})
	return applyEdits(text, edits, nil)
}

type edit struct {
	offset, length int
	text           string
}

// applyEdits makes edits, from the last back, and adds imports after the
// package clause. The checker may report one problem more than once, so an
// offset is edited once.
func applyEdits(text string, edits []edit, imports map[string]bool) string {
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].offset > edits[j].offset })
	edited := map[int]bool{}
	for _, e := range edits {
		if edited[e.offset] {
			continue
		}
		edited[e.offset] = true
		text = text[:e.offset] + e.text + text[e.offset+e.length:]
	}
	var lines []string
	for spec := range imports {
		lines = append(lines, "import "+spec)
	}
	sort.Strings(lines)
	if len(lines) > 0 {
		clause, rest, _ := strings.Cut(text, "\n")
		text = clause + "\n\n" + strings.Join(lines, "\n") + "\n" + rest
	}
	return text
}

// lookup is the checker's view of compiled packages: export data, which the
// go command produces for any package the session can import.
func (s *Session) lookup(path string) (io.ReadCloser, error) {
	if _, ok := s.exports[path]; !ok {
		out, err := goRun(s.dir, "list", "-export", "-deps", "-f", "{{.ImportPath}}\t{{.Export}}", path)
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			if p, file, ok := strings.Cut(line, "\t"); ok && file != "" {
				s.exports[p] = file
			}
		}
	}
	return os.Open(s.exports[path])
}
