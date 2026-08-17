class PreservationSeriesLink < ApplicationRecord
  belongs_to :preservation_source
  belongs_to :series

  validates :source_series_id, presence: true, uniqueness: { scope: :preservation_source_id }
  validates :source_url, presence: true
end
