// Package cell turns a cell's source into a package: its statements become
// package-level initializers, which Go runs once, in declaration order, when
// the package loads.
package cell

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"strconv"
	"strings"
)

// Reserved names of the source the engine generates.
const (
	// Mangle prefixes every name the engine makes and every unexported name
	// it exports; users' names never begin with it.
	Mangle = "Bayma_"
	// ResultVar holds the values of a cell's final expression.
	ResultVar = Mangle + "result"
	// valuesHelper gathers them, however many the expression has.
	valuesHelper = Mangle + "values"
)

// A Cell, as the package-level source Go accepts.
type Cell struct {
	imports []string // import specs as written, such as `gh "github.com/google/go-github/v92/github"`
	body    []string // package-level declarations, in the cell's order
	result  string   // the cell's final expression, if it ends in one
}

// Parse reads a cell: imports, then declarations and statements in any order.
func Parse(source string) (*Cell, error) {
	const header = "package cell\n"
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "", header+source, parser.ImportsOnly)
	if err != nil {
		return nil, err
	}
	c := &Cell{}
	rest := 0
	for _, decl := range file.Decls {
		rest = fset.Position(decl.End()).Offset - len(header)
	}
	for _, spec := range file.Imports {
		start := fset.Position(spec.Pos()).Offset - len(header)
		end := fset.Position(spec.End()).Offset - len(header)
		c.imports = append(c.imports, source[start:end])
	}

	scope := &scope{declared: map[string]bool{}}
	var statements []string
	flush := func(last bool) error {
		if len(statements) == 0 {
			return nil
		}
		items, result, err := scope.hoist(strings.Join(statements, "\n"), last)
		statements = nil
		c.body = append(c.body, items...)
		if result != "" {
			c.result = result
		}
		return err
	}
	items := topLevelItems(source[rest:])
	for i, item := range items {
		if names, ok := declaration(item); ok {
			if err := flush(false); err != nil {
				return nil, err
			}
			c.body = append(c.body, item)
			for _, name := range names {
				scope.declared[name] = true
			}
			continue
		}
		statements = append(statements, item)
		if i == len(items)-1 {
			if err := flush(true); err != nil {
				return nil, err
			}
		}
	}
	return c, nil
}

// Imports are the cell's import paths.
func (c *Cell) Imports() []string {
	paths := make([]string, len(c.imports))
	for i, spec := range c.imports {
		paths[i] = spec[strings.Index(spec, `"`):]
		paths[i], _ = strconv.Unquote(paths[i])
	}
	return paths
}

// BlankImport makes the cell's import of path blank, for a package it imports
// only for the cells after it, and reports whether that changed the cell.
func (c *Cell) BlankImport(path string) bool {
	for i, spec := range c.imports {
		if strings.HasSuffix(spec, strconv.Quote(path)) && !strings.HasPrefix(spec, "_ ") {
			c.imports[i] = "_ " + strconv.Quote(path)
			return true
		}
	}
	return false
}

// HasResult reports whether the cell ends in an expression.
func (c *Cell) HasResult() bool { return c.result != "" }

// Source is the cell's package. Its final expression's values become its
// result when asValue is set; a call that returns nothing runs as a
// statement instead.
func (c *Cell) Source(pkg string, asValue bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "package %s\n\n", pkg)
	for _, spec := range c.imports {
		fmt.Fprintf(&b, "import %s\n", spec)
	}
	b.WriteString("\n")
	for _, item := range c.body {
		b.WriteString(item + "\n\n")
	}
	switch {
	case c.result != "" && asValue:
		fmt.Fprintf(&b, "var %s = %s(%s)\n\nfunc %s(values ...any) []any { return values }\n",
			ResultVar, valuesHelper, c.result, valuesHelper)
	case c.result != "":
		b.WriteString(initializer(c.result) + "\n")
	}
	return b.String()
}

// topLevelItems splits source at its top-level semicolons, written or implied
// by line ends, into the statements and declarations it holds.
func topLevelItems(source string) []string {
	fset := token.NewFileSet()
	var s scanner.Scanner
	s.Init(fset.AddFile("", fset.Base(), len(source)), []byte(source), nil, 0)
	var items []string
	depth, start := 0, -1
	for {
		pos, tok, lit := s.Scan()
		offset := fset.Position(pos).Offset
		switch {
		case tok == token.EOF:
			if start >= 0 && strings.TrimSpace(source[start:]) != "" {
				items = append(items, strings.TrimSpace(source[start:]))
			}
			return items
		case tok == token.SEMICOLON && depth == 0:
			// An implied semicolon's literal is "\n"; it ends where it starts.
			end := offset
			if lit == ";" {
				end++
			}
			if start >= 0 {
				items = append(items, strings.TrimSpace(source[start:end]))
			}
			start = -1
			continue
		case tok == token.LPAREN || tok == token.LBRACE || tok == token.LBRACK:
			depth++
		case tok == token.RPAREN || tok == token.RBRACE || tok == token.RBRACK:
			depth--
		}
		if start < 0 {
			start = offset
		}
	}
}

// declaration reports whether an item is a package-level declaration, a
// function, method, type, var, or const, and the names it declares. A
// function literal called as a statement also begins with func, and does not
// parse as one.
func declaration(item string) (names []string, ok bool) {
	switch strings.Fields(item)[0] {
	case "type", "var", "const", "func":
	default:
		return nil, false
	}
	file, err := parser.ParseFile(token.NewFileSet(), "", "package cell\n"+item, 0)
	if err != nil {
		return nil, false
	}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Recv == nil {
				names = append(names, d.Name.Name)
			}
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					names = append(names, s.Name.Name)
				case *ast.ValueSpec:
					for _, n := range s.Names {
						names = append(names, n.Name)
					}
				}
			}
		}
	}
	return names, true
}

// What a cell has declared so far, and how many temporaries it has used.
type scope struct {
	declared    map[string]bool
	temporaries int
}

// hoist turns statements into package-level declarations: `a, b := f()`
// becomes `var a, b = f()`, the cell's final expression becomes its result,
// and every other run of statements becomes one initializer, in order.
func (s *scope) hoist(statements string, last bool) (items []string, result string, err error) {
	const prefix = "package cell\nfunc _() {\n"
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "", prefix+statements+"\n}", 0)
	if err != nil {
		return nil, "", err
	}
	text := func(n ast.Node) string {
		return statements[fset.Position(n.Pos()).Offset-len(prefix) : fset.Position(n.End()).Offset-len(prefix)]
	}
	body := file.Decls[0].(*ast.FuncDecl).Body.List
	var run []string
	flush := func() {
		if len(run) > 0 {
			items = append(items, initializer(strings.Join(run, "\n")))
			run = nil
		}
	}
	for i, stmt := range body {
		if assign, ok := stmt.(*ast.AssignStmt); ok && assign.Tok == token.DEFINE {
			flush()
			// As in a function, := assigns the names this cell already
			// declared, through temporaries, and declares the rest.
			names := make([]string, len(assign.Lhs))
			var reassigned []string
			for j, lhs := range assign.Lhs {
				names[j] = text(lhs)
				if s.declared[names[j]] {
					s.temporaries++
					temporary := fmt.Sprintf("%stemporary%d", Mangle, s.temporaries)
					reassigned = append(reassigned, fmt.Sprintf("%s = %s", names[j], temporary))
					names[j] = temporary
				} else if names[j] != "_" {
					s.declared[names[j]] = true
				}
			}
			values := make([]string, len(assign.Rhs))
			for j, rhs := range assign.Rhs {
				values[j] = text(rhs)
			}
			items = append(items, fmt.Sprintf("var %s = %s", strings.Join(names, ", "), strings.Join(values, ", ")))
			if len(reassigned) > 0 {
				items = append(items, initializer(strings.Join(reassigned, "\n")))
			}
			continue
		}
		if expr, ok := stmt.(*ast.ExprStmt); ok && last && i == len(body)-1 {
			flush()
			result = text(expr.X)
			continue
		}
		run = append(run, text(stmt))
	}
	flush()
	return items, result, nil
}

// initializer runs statements where Go allows only declarations: as the
// initializer of a blank variable, which Go runs in declaration order.
func initializer(statements string) string {
	return fmt.Sprintf("var _ = func() struct{} {\n%s\nreturn struct{}{}\n}()", statements)
}
