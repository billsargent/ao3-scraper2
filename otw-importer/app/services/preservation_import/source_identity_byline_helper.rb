module PreservationImport
  module SourceIdentityBylineHelper
    def byline(creation, options = {})
      identities = preservation_identities_for(creation)
      return super if identities.blank?
      return t("byline_helper.anonymous_byline") if identities.all?(&:anonymous?)

      safe_join(identities.map { |identity| source_identity_name(identity, text_only: false) }, t("support.array.words_connector"))
    end

    def text_byline(creation, options = {})
      identities = preservation_identities_for(creation)
      return super if identities.blank?
      return t("byline_helper.anonymous_byline") if identities.all?(&:anonymous?)

      identities.map(&:display_name).to_sentence
    end

    def creators_for_feed(creation)
      identities = preservation_identities_for(creation)
      return super if identities.blank?
      if identities.all?(&:anonymous?)
        yield t("byline_helper.anonymous_byline")
      else
        identities.each { |identity| yield identity.display_name, identity.profile_url }
      end
    end

    private

    def preservation_identities_for(creation)
      return [] unless creation.is_a?(Work)
      link = creation.preservation_work_link
      link ? link.preservation_author_identities.to_a : []
    end

    def source_identity_name(identity, text_only:)
      return identity.display_name if text_only || identity.profile_url.blank?
      link_to(identity.display_name, identity.profile_url, rel: "author external")
    end
  end
end
