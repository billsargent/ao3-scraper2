# Copy this file to config/initializers/preservation_import.rb in OTW Archive.
Rails.application.config.to_prepare do
  Work.has_one :preservation_work_link, dependent: :restrict_with_exception unless Work.reflect_on_association(:preservation_work_link)
  Chapter.has_one :preservation_chapter_link, dependent: :restrict_with_exception unless Chapter.reflect_on_association(:preservation_chapter_link)
  Series.has_one :preservation_series_link, dependent: :restrict_with_exception unless Series.reflect_on_association(:preservation_series_link)

  BylineHelper.prepend(PreservationImport::SourceIdentityBylineHelper) unless BylineHelper < PreservationImport::SourceIdentityBylineHelper
  Work.prepend(PreservationImport::WorkIndexExtension) unless Work < PreservationImport::WorkIndexExtension
end
