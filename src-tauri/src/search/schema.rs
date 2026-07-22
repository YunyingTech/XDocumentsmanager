use tantivy::schema::{Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, FAST, INDEXED, STORED, STRING};

#[derive(Clone)]
pub struct SearchFields {
    pub file_id: Field,
    pub folder_id: Field,
    pub file_name: Field,
    pub content: Field,
    pub title: Field,
    pub author: Field,
    pub keywords: Field,
    pub extension: Field,
    pub modified_at: Field,
    pub size_bytes: Field,
}

pub fn build_schema() -> (Schema, SearchFields) {
    let mut builder = Schema::builder();
    let indexed_text = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("xd_text")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();
    let indexed_content = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("xd_text")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );

    let fields = SearchFields {
        file_id: builder.add_i64_field("file_id", INDEXED | STORED | FAST),
        folder_id: builder.add_i64_field("folder_id", INDEXED | STORED | FAST),
        file_name: builder.add_text_field("file_name", indexed_text.clone()),
        content: builder.add_text_field("content", indexed_content),
        title: builder.add_text_field("title", indexed_text.clone()),
        author: builder.add_text_field("author", indexed_text.clone()),
        keywords: builder.add_text_field("keywords", indexed_text),
        extension: builder.add_text_field("extension", STRING | STORED),
        modified_at: builder.add_text_field("modified_at", STRING | STORED),
        size_bytes: builder.add_i64_field("size_bytes", INDEXED | STORED | FAST),
    };

    (builder.build(), fields)
}
