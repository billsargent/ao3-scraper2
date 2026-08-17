class CreatePreservationImportTables < ActiveRecord::Migration[8.1]
  def change
    create_table :preservation_sources do |t|
      t.string :key, null: false
      t.string :origin, null: false
      t.timestamps
      t.index :key, unique: true
    end

    create_table :preservation_author_identities do |t|
      t.references :preservation_source, null: false, foreign_key: true
      t.string :source_author_id, null: false
      t.string :display_name, null: false
      t.string :profile_url
      t.boolean :anonymous, null: false, default: false
      t.boolean :orphaned, null: false, default: false
      t.timestamps
      t.index [:preservation_source_id, :source_author_id], unique: true, name: "idx_preservation_authors_source_identity"
    end

    create_table :preservation_work_links do |t|
      t.references :preservation_source, null: false, foreign_key: true
      t.references :work, null: false, foreign_key: true, type: :integer
      t.string :source_work_id, null: false
      t.string :source_url, null: false
      t.string :imported_hash, null: false
      t.date :source_updated_at
      t.datetime :last_imported_at, null: false
      t.timestamps
      t.index [:preservation_source_id, :source_work_id], unique: true, name: "idx_preservation_works_source_identity"
      t.index :work_id, unique: true
    end

    create_table :preservation_work_authors do |t|
      t.references :preservation_work_link, null: false, foreign_key: true
      t.references :preservation_author_identity, null: false, foreign_key: true
      t.integer :position, null: false
      t.timestamps
      t.index [:preservation_work_link_id, :preservation_author_identity_id], unique: true, name: "idx_preservation_work_author_unique"
    end

    create_table :preservation_chapter_links do |t|
      t.references :preservation_work_link, null: false, foreign_key: true
      t.references :chapter, null: false, foreign_key: true, type: :integer
      t.string :source_chapter_id, null: false
      t.string :imported_hash, null: false
      t.timestamps
      t.index [:preservation_work_link_id, :source_chapter_id], unique: true, name: "idx_preservation_chapters_source_identity"
      t.index :chapter_id, unique: true
    end

    create_table :preservation_series_links do |t|
      t.references :preservation_source, null: false, foreign_key: true
      t.references :series, null: false, foreign_key: true, type: :integer
      t.string :source_series_id, null: false
      t.string :source_url, null: false
      t.timestamps
      t.index [:preservation_source_id, :source_series_id], unique: true, name: "idx_preservation_series_source_identity"
      t.index :series_id, unique: true
    end

    create_table :preservation_import_runs do |t|
      t.string :package_id, null: false
      t.string :package_path, null: false
      t.string :status, null: false, default: "running"
      t.integer :works_created, null: false, default: 0
      t.integer :works_updated, null: false, default: 0
      t.integer :works_skipped, null: false, default: 0
      t.integer :works_failed, null: false, default: 0
      t.text :error_message
      t.datetime :completed_at
      t.timestamps
      t.index :package_id, unique: true
    end
  end
end
