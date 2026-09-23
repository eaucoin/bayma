use std::fs;

#[test]
fn representative_packages_work_as_their_ordinary_crates() {
    use grep::matcher::Matcher;

    let fixture = tempfile::tempdir().unwrap();
    fs::create_dir(fixture.path().join(".git")).unwrap();
    fs::create_dir(fixture.path().join("src")).unwrap();
    fs::create_dir(fixture.path().join("ignored")).unwrap();
    fs::write(fixture.path().join(".gitignore"), "ignored/\n").unwrap();
    fs::write(
        fixture.path().join("Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.0.0\"\n",
    )
    .unwrap();
    fs::write(fixture.path().join("src/lib.rs"), "pub struct Widget;\n").unwrap();
    fs::write(
        fixture.path().join("ignored/hidden.rs"),
        "pub struct Hidden;\n",
    )
    .unwrap();

    let entries = ignore::WalkBuilder::new(fixture.path())
        .build()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .path()
                .strip_prefix(fixture.path())
                .ok()
                .map(|path| path.to_path_buf())
        })
        .collect::<Vec<_>>();
    assert!(entries.iter().any(|path| path.ends_with("src/lib.rs")));
    assert!(!entries
        .iter()
        .any(|path| path.ends_with("ignored/hidden.rs")));

    let matcher = grep::regex::RegexMatcher::new(r"Widget|answer").unwrap();
    assert_eq!(
        matcher
            .find(b"pub struct Widget;")
            .unwrap()
            .unwrap()
            .start(),
        11
    );

    let document = fs::read_to_string(fixture.path().join("Cargo.toml")).unwrap();
    let parsed = document.parse::<toml_edit::DocumentMut>().unwrap();
    assert_eq!(parsed["package"]["name"].as_str(), Some("fixture"));
}

#[test]
fn rust_analyzer_layers_work_as_their_ordinary_crates() {
    use ra_ap_base_db::{
        AbsPathBuf, CrateGraphBuilder, CrateOrigin, CrateWorkspaceData, Env, FileId, FileSet,
        SourceRoot, VfsPath,
    };
    use ra_ap_hir::{ChangeWithProcMacros, Crate, ModuleDef};
    use ra_ap_ide::{AnalysisHost, Edition, FileStructureConfig};
    use ra_ap_syntax::{ast, ast::HasName, AstNode, SourceFile};

    let source = r#"
pub struct Widget {
    value: u32,
}

impl Widget {
    pub fn answer(&self) -> u32 {
        self.value
    }
}
"#;

    let parsed = SourceFile::parse(source, Edition::CURRENT);
    assert!(parsed.errors().is_empty());
    let syntax_names = parsed
        .tree()
        .syntax()
        .descendants()
        .filter_map(ast::Fn::cast)
        .filter_map(|function| function.name())
        .map(|name| name.text().to_string())
        .collect::<Vec<_>>();
    assert_eq!(syntax_names, ["answer"]);

    let file_id = FileId::from_raw(0);
    let mut files = FileSet::default();
    files.insert(file_id, VfsPath::new_virtual_path("/lib.rs".to_owned()));

    let mut crate_graph = CrateGraphBuilder::default();
    crate_graph.add_crate_root(
        file_id,
        Edition::CURRENT,
        None,
        None,
        ra_ap_cfg::CfgOptions::default(),
        None,
        Env::default(),
        CrateOrigin::Local {
            repo: None,
            name: None,
        },
        Vec::new(),
        false,
        AbsPathBuf::try_from("/").unwrap().into(),
        CrateWorkspaceData {
            target: Err("fixture has no target layout".into()),
            toolchain: None,
        }
        .into(),
    );

    let mut change = ChangeWithProcMacros::default();
    change.set_roots(vec![SourceRoot::new_local(files)]);
    change.change_file(file_id, Some(source.to_owned()));
    change.set_crate_graph(crate_graph);

    let mut host = AnalysisHost::default();
    host.apply_change(change);

    let database = host.raw_database();
    let crates = Crate::all(database);
    assert_eq!(crates.len(), 1);
    let declarations = crates[0].root_module(database).declarations(database);
    assert!(declarations.iter().any(|definition| {
        matches!(definition, ModuleDef::Adt(_))
            && definition
                .name(database)
                .is_some_and(|name| name.as_str() == "Widget")
    }));

    let outline = host
        .analysis()
        .file_structure(
            &FileStructureConfig {
                exclude_locals: false,
            },
            file_id,
        )
        .unwrap();
    assert!(outline.iter().any(|node| node.label == "Widget"));
    assert!(outline.iter().any(|node| node.label == "answer"));
}
