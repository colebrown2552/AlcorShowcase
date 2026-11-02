<?php
/**
 * Plugin Name: Alcor FAQ Schema
 * Description: One FAQ list that a page both shows and describes to search engines as schema.org FAQPage data. Use the [alcor_faq] shortcode.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * Search engines only accept FAQ structured data when the questions and answers are also visible on the page. The
 * way to keep the two from drifting apart is to have only one copy: alcor_public_faq_entries() is the single list,
 * and the [alcor_faq] shortcode prints the visible questions and the FAQPage JSON-LD from that same array. A site
 * replaces the entries with the alcor_faq_entries filter:
 *
 *     add_filter( 'alcor_faq_entries', static function () {
 *         return array( array( 'question' => 'Is it free?', 'answer' => 'Yes.' ) );
 *     } );
 *
 * Only the first [alcor_faq] on a page emits JSON-LD: a page may carry one FAQPage, and a second list would
 * describe questions the first one already declared.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Returns the FAQ entries.
 *
 * @return array<int, array{question: string, answer: string}> Plain-text questions and answers.
 */
function alcor_public_faq_entries() {
	$entries = array(
		array(
			'question' => 'Who builds my site?',
			'answer'   => 'You work directly with the developer building it. There is no account manager in between.',
		),
		array(
			'question' => 'How much does it cost?',
			'answer'   => 'It depends on the job, so every job gets a written quote. Tell us what you need and we will send the price and what is included before any work starts. Hosting is not included: you will need your own web hosting.',
		),
		array(
			'question' => 'Do I own what you build?',
			'answer'   => 'Yes. The code, plugin and site we deliver for your project belong to you.',
		),
		array(
			'question' => "I'm not technical. Is that a problem?",
			'answer'   => "No. Describe what you need in your own words, and we'll ask about anything technical that affects the quote.",
		),
	);
	/**
	 * Filters the FAQ entries that [alcor_faq] prints and describes.
	 *
	 * @param array $entries Each entry has a plain-text 'question' and 'answer'.
	 */
	$entries = apply_filters( 'alcor_faq_entries', $entries );
	// Anything that is not a question with an answer is dropped, so a bad filter cannot emit broken structured data.
	return array_values(
		array_filter(
			(array) $entries,
			static function ( $entry ) {
				return is_array( $entry ) && isset( $entry['question'], $entry['answer'] )
					&& is_string( $entry['question'] ) && is_string( $entry['answer'] )
					&& '' !== trim( $entry['question'] ) && '' !== trim( $entry['answer'] );
			}
		)
	);
}

/**
 * Builds the schema.org FAQPage description of a list of entries.
 *
 * @param array<int, array{question: string, answer: string}> $entries The same entries the page shows.
 * @return array The FAQPage, ready for wp_json_encode().
 */
function alcor_faq_schema( array $entries ) {
	$questions = array();
	foreach ( $entries as $entry ) {
		$questions[] = array(
			'@type'          => 'Question',
			'name'           => $entry['question'],
			'acceptedAnswer' => array(
				'@type' => 'Answer',
				'text'  => $entry['answer'],
			),
		);
	}
	return array(
		'@context'   => 'https://schema.org',
		'@type'      => 'FAQPage',
		'mainEntity' => $questions,
	);
}

/**
 * Prints the visible list: one <details> element per entry.
 *
 * @param array<int, array{question: string, answer: string}> $entries The entries to show.
 * @param string                                              $heading Heading above the list.
 * @return string HTML.
 */
function alcor_faq_html( array $entries, $heading ) {
	$html = '<section class="alcor-faq"><h2>' . esc_html( $heading ) . '</h2>';
	foreach ( $entries as $entry ) {
		$html .= '<details><summary>' . esc_html( $entry['question'] ) . '</summary><p>' . esc_html( $entry['answer'] ) . '</p></details>';
	}
	return $html . '</section>';
}

/**
 * The [alcor_faq] shortcode: the visible list plus its FAQPage JSON-LD.
 *
 * @param array|string $atts Shortcode attributes; "heading" sets the heading text.
 * @return string HTML, or '' when there are no entries.
 */
function alcor_faq_shortcode( $atts ) {
	static $schema_printed = false;
	$atts    = shortcode_atts(
		array( 'heading' => 'Frequently asked questions' ),
		$atts,
		'alcor_faq'
	);
	$entries = alcor_public_faq_entries();
	if ( ! $entries ) {
		return '';
	}
	$html = alcor_faq_html( $entries, $atts['heading'] );
	if ( ! $schema_printed ) {
		$schema_printed = true;
		// JSON_HEX_TAG turns "<" and ">" into escapes, so an answer containing "</script>" cannot end the block early.
		$json  = wp_json_encode( alcor_faq_schema( $entries ), JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		$html .= '<script type="application/ld+json">' . $json . '</script>';
	}
	return $html;
}
add_shortcode( 'alcor_faq', 'alcor_faq_shortcode' );
